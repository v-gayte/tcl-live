require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---

// [OPT] Gzip compression — réduit la taille des réponses JSON de ~60-70%
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// URLs des API Grand Lyon & SYTRAL
const BUSES_URL        = "https://data.grandlyon.com/siri-lite/2.0/vehicle-monitoring.json";
const ALERTS_URL       = "https://download.data.grandlyon.com/ws/rdata/tcl_sytral.tclalertetrafic_2/all.json?maxfeatures=-1&start=1";
const STOPS_URL        = "https://download.data.grandlyon.com/ws/rdata/tcl_sytral.tclarret/all.json?maxfeatures=-1";
const ZONES_URL        = "https://download.data.grandlyon.com/ws/rdata/tcl_sytral.tclzonearret/all.json?maxfeatures=-1";
const BUS_ROUTES_URL   = "https://download.data.grandlyon.com/wfs/sytral?SERVICE=WFS&VERSION=2.0.0&request=GetFeature&typename=sytral:tcl_sytral.tcllignebus_2_0_0&outputFormat=application/json&SRSNAME=EPSG:4326";
const TRAM_ROUTES_URL  = "https://download.data.grandlyon.com/wfs/sytral?SERVICE=WFS&VERSION=2.0.0&request=GetFeature&typename=sytral:tcl_sytral.tcllignetram_2_0_0&outputFormat=application/json&SRSNAME=EPSG:4326";
const METRO_ROUTES_URL = "https://download.data.grandlyon.com/wfs/sytral?SERVICE=WFS&VERSION=2.0.0&request=GetFeature&typename=sytral:tcl_sytral.tcllignemf_2_0_0&outputFormat=application/json&SRSNAME=EPSG:4326";
// [FIX] URL corrigée : API officielle download.data.grandlyon.com (format canonique)
const ARRIVALS_URL     = "https://download.data.grandlyon.com/ws/rdata/tcl_sytral.tclpassagearret/all.json?maxfeatures=-1&start=1";

// Authentification API
const USERNAME    = process.env.API_USER?.trim();
const PASSWORD    = process.env.API_PASSWORD?.trim();
const credentials = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
const AUTH_HEADER = { 'Authorization': `Basic ${credentials}`, 'Accept': 'application/json' };

// --- CACHES ---

let busCache        = null;
let busLastFetch    = 0;
const BUS_TTL       = 15000; // 15s

let stopsCache      = null;
let routesCache     = null;

// [OPT] Cache pour les alertes (changent rarement)
let alertsCache     = null;
let alertsLastFetch = 0;
const ALERTS_TTL    = 2 * 60 * 1000; // 2 min

// [OPT] Cache GLOBAL pour tous les passages — rafraîchissement PROACTIF
// [FIX] Le cache n'est valide que si des données sont présentes (nb_results > 0)
let allArrivalsCache   = null;
let allArrivalsFetchTs = 0;
const ALL_ARRIVALS_TTL    = 15000; // 15s entre deux refresh si données OK
const ARRIVALS_EMPTY_TTL  = 30000; // 30s entre deux tentatives si source vide

/**
 * Helper : fetch avec timeout pour éviter les blocages sur l'API Grand Lyon.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

// --- ROUTES API ---

/**
 * Récupère les tracés WFS (bus + tram).
 * Mis en cache indéfiniment car les données sont stables.
 */
app.get('/api/routes', async (req, res) => {
    if (routesCache) return res.json(routesCache);
    try {
        console.log("⏳ Chargement des tracés via WFS...");
        const [resBus, resTram, resMetro] = await Promise.all([
            fetch(BUS_ROUTES_URL),
            fetch(TRAM_ROUTES_URL),
            fetch(METRO_ROUTES_URL)
        ]);
        const busData   = await resBus.json();
        const tramData  = await resTram.json();
        const metroData = await resMetro.json();
        const filterFeatures = (features) => features.filter(f => {
            const name = f.properties.ligne || f.properties.code_ligne || f.properties.nom;
            return name && !name.startsWith('JD');
        });

        routesCache = {
            bus:   filterFeatures(busData.features   || []),
            tram:  filterFeatures(tramData.features  || []),
            metro: filterFeatures(metroData.features || [])
        };
        console.log(`✅ Tracés chargés : ${routesCache.bus.length} bus, ${routesCache.tram.length} trams, ${routesCache.metro.length} métros.`);
        res.json(routesCache);
    } catch (e) {
        console.error("⚠️ Erreur tracés WFS:", e);
        res.status(500).json({ error: "Erreur tracés" });
    }
});

/**
 * Récupère les positions des bus en temps réel.
 * Rafraîchi toutes les 15 secondes via cache.
 */
app.get('/api/buses', async (req, res) => {
    const now = Date.now();
    if (busCache && (now - busLastFetch < BUS_TTL)) return res.json(busCache);
    try {
        const response = await fetchWithTimeout(BUSES_URL, { headers: AUTH_HEADER });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const rawData = await response.json();

        // [FIX] Vérification robuste de la présence de VehicleActivity
        const delivery = rawData?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0];
        const hasData  = Array.isArray(delivery?.VehicleActivity) && delivery.VehicleActivity.length > 0;

        if (hasData) {
            // Filtrage des JD et lignes sans nom
            delivery.VehicleActivity = delivery.VehicleActivity.filter(v => {
                const lineRef = v.MonitoredVehicleJourney?.LineRef?.value;
                if (!lineRef) return false;
                const parts = lineRef.split(':');
                const lineName = parts.slice(1).find(p => p && p !== 'Line') || parts[0];
                return lineName && !lineName.startsWith('JD');
            });
            busCache    = rawData;
            busLastFetch = now;
        } else {
            // [FIX] Source vide : on ne met pas à jour le cache, on renvoie le cache existant ou vide
            console.warn(`⚠️ vehicle-monitoring vide (aucun VehicleActivity). Cache conservé.`);
            if (!busCache) busCache = rawData; // premier appel : on stocke quand même la structure
            // Ne pas mettre à jour busLastFetch → réessai au prochain appel sans attendre BUS_TTL
        }

        res.json(busCache);
    } catch (e) {
        console.error('⚠️ Erreur bus:', e.message);
        if (busCache) return res.json(busCache); // renvoyer le dernier cache valide si possible
        res.status(500).json({ error: e.message });
    }
});

/**
 * Récupère les alertes trafic.
 * Cache de 2 minutes.
 */
app.get('/api/alerts', async (req, res) => {
    const now = Date.now();
    if (alertsCache && (now - alertsLastFetch < ALERTS_TTL)) return res.json(alertsCache);
    try {
        const response = await fetchWithTimeout(ALERTS_URL, { headers: AUTH_HEADER });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        alertsCache     = await response.json();
        alertsLastFetch = now;
        res.json(alertsCache);
    } catch (e) {
        console.error('⚠️ Erreur alertes:', e.message);
        if (alertsCache) return res.json(alertsCache);
        res.status(500).json({ error: "Erreur alertes" });
    }
});

/**
 * Récupère la liste des arrêts (nom + géolocalisation).
 * Mis en cache indéfiniment au démarrage.
 */
app.get('/api/stops', async (req, res) => {
    if (stopsCache) return res.json(stopsCache);
    try {
        let dict = {};
        let geo  = [];

        try {
            const resArrets  = await fetch(STOPS_URL, { headers: AUTH_HEADER });
            const dataArrets = await resArrets.json();
            (dataArrets.values || []).forEach(a => {
                dict[a.id] = a.nom;
                if (a.lat && a.lon && a.desserte) {
                    const lines = [...new Set(
                        a.desserte.split(',')
                            .map(d => d.split(':')[0].trim())
                            .filter(l => l && !l.startsWith('JD'))
                    )];
                    if (lines.length > 0) {
                        geo.push({ id: a.id, nom: a.nom, lat: a.lat, lng: a.lon, lines });
                    }
                }
            });
        } catch(e) {}

        try {
            const resZones  = await fetch(ZONES_URL, { headers: AUTH_HEADER });
            const dataZones = await resZones.json();
            (dataZones.values || []).forEach(z => { dict[z.id] = z.nom; });
        } catch(e) {}

        stopsCache = { dict, geo };
        res.json(stopsCache);
    } catch (e) {
        res.status(500).json({ error: "Erreur arrêts" });
    }
});

/**
 * Met à jour le cache global des passages.
 * [FIX] Ne stocke le cache que si des données sont présentes (évite de cacher une source vide).
 */
async function refreshAllArrivals() {
    try {
        const response = await fetchWithTimeout(ARRIVALS_URL, { headers: AUTH_HEADER }, 12000);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const nbResults = data?.nb_results ?? (data?.values?.length ?? 0);

        if (nbResults > 0) {
            allArrivalsCache   = data;
            allArrivalsFetchTs = Date.now();
            console.log(`✅ Cache passages mis à jour : ${nbResults} entrées.`);
        } else {
            // [FIX] Source vide : ne pas écraser un cache valide, noter l'heure pour le backoff
            console.warn(`⚠️ tclpassagearret vide (nb_results=0). Cache existant conservé.`);
            allArrivalsFetchTs = Date.now() - ALL_ARRIVALS_TTL + ARRIVALS_EMPTY_TTL; // backoff 30s
        }
    } catch (e) {
        console.warn('⚠️ Rafraîchissement passages échoué:', e.message);
    }
}

/**
 * Récupère les passages pour un arrêt spécifique à partir du cache global.
 * [FIX] Retourne un champ `sourceEmpty` si la source Grand Lyon ne fournit pas de données.
 */
app.get('/api/arrivals/:stopId', async (req, res) => {
    const stopId = parseInt(req.params.stopId, 10);
    if (!stopId) return res.status(400).json({ error: 'stopId invalide' });

    try {
        const now = Date.now();
        const cacheAge = now - allArrivalsFetchTs;
        const needsRefresh = !allArrivalsCache || cacheAge > ALL_ARRIVALS_TTL;

        if (needsRefresh) await refreshAllArrivals();

        const allValues = allArrivalsCache?.values || [];
        const sourceEmpty = allValues.length === 0;

        const passages = allValues
            .filter(p => p.id === stopId)
            .map(p => ({
                ligne:     p.ligne,
                direction: p.direction,
                delai:     p.delaipassage,
                heure:     p.heurepassage,
                type:      p.type,
            }))
            .sort((a, b) => new Date(a.heure) - new Date(b.heure));

        res.json({ stopId, passages, sourceEmpty });
    } catch (e) {
        res.status(500).json({ error: 'Erreur passages: ' + e.message });
    }
});

// --- DÉMARRAGE SERVEUR ---

app.listen(PORT, async () => {
    console.log(`🚀 Serveur TCL Live démarré : http://localhost:${PORT}`);

    // 1. Pré-chargement des arrêts (dictionnaire + géo)
    try {
        console.log("⏳ Téléchargement des arrêts...");
        const resArrets  = await fetchWithTimeout(STOPS_URL, { headers: AUTH_HEADER });
        const dataArrets = await resArrets.json();
        let dict = {}, geo = [];
        (dataArrets.values || []).forEach(a => {
            dict[a.id] = a.nom;
            if (a.lat && a.lon && a.desserte) {
                const lines = [...new Set(
                    a.desserte.split(',').map(d => d.split(':')[0].trim()).filter(Boolean)
                )];
                if (lines.length > 0) geo.push({ id: a.id, nom: a.nom, lat: a.lat, lng: a.lon, lines });
            }
        });
        try {
            const resZones  = await fetchWithTimeout(ZONES_URL, { headers: AUTH_HEADER });
            const dataZones = await resZones.json();
            (dataZones.values || []).forEach(z => { dict[z.id] = z.nom; });
        } catch(e) {}
        stopsCache = { dict, geo };
        console.log(`✅ ${Object.keys(dict).length} noms | ${geo.length} arrêts géolocalisés !`);
    } catch(e) {
        console.warn("⚠️ Pré-chargement arrêts échoué, sera chargé à la première requête.", e.message);
    }

    // 2. Pré-chargement des passages — cache chaud dès le 1er clic
    console.log("⏳ Pré-chargement des passages en cours...");
    await refreshAllArrivals();
    const nbPassages = allArrivalsCache?.values?.length || 0;
    if (nbPassages > 0) {
        console.log(`✅ Cache passages prêt (${nbPassages} entrées) !`);
    } else {
        console.warn("⚠️ Source passages vide au démarrage. Le serveur réessaiera automatiquement.");
    }

    // 3. Rafraîchissement proactif en arrière-plan
    setInterval(refreshAllArrivals, ALL_ARRIVALS_TTL);
    console.log(`🔄 Rafraîchissement automatique des passages toutes les ${ALL_ARRIVALS_TTL / 1000}s activé.`);
});
