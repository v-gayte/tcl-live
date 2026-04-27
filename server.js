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
const BUSES_URL   = "https://data.grandlyon.com/siri-lite/2.0/vehicle-monitoring.json";
const ALERTS_URL  = "https://data.grandlyon.com/fr/datapusher/ws/rdata/tcl_sytral.tclalertetrafic_2/all.json?maxfeatures=-1&start=1";
const STOPS_URL   = "https://data.grandlyon.com/fr/datapusher/ws/rdata/tcl_sytral.tclarret/all.json?maxfeatures=-1";
const ZONES_URL   = "https://data.grandlyon.com/fr/datapusher/ws/rdata/tcl_sytral.tclzonearret/all.json?maxfeatures=-1";
const BUS_ROUTES_URL  = "https://download.data.grandlyon.com/wfs/sytral?SERVICE=WFS&VERSION=2.0.0&request=GetFeature&typename=sytral:tcl_sytral.tcllignebus_2_0_0&outputFormat=application/json&SRSNAME=EPSG:4326";
const TRAM_ROUTES_URL = "https://download.data.grandlyon.com/wfs/sytral?SERVICE=WFS&VERSION=2.0.0&request=GetFeature&typename=sytral:tcl_sytral.tcllignetram_2_0_0&outputFormat=application/json&SRSNAME=EPSG:4326";
const METRO_ROUTES_URL = "https://download.data.grandlyon.com/wfs/sytral?SERVICE=WFS&VERSION=2.0.0&request=GetFeature&typename=sytral:tcl_sytral.tcllignemf_2_0_0&outputFormat=application/json&SRSNAME=EPSG:4326";
const ARRIVALS_URL = "https://data.grandlyon.com/fr/datapusher/ws/rdata/tcl_sytral.tclpassagearret/all.json?maxfeatures=-1&start=1";

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
let allArrivalsCache   = null;
let allArrivalsFetchTs = 0;
const ALL_ARRIVALS_TTL = 15000; // 15s

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
        const response = await fetch(BUSES_URL, { headers: AUTH_HEADER });
        const rawData = await response.json();
        
        // Filtrage des JD et lignes sans nom
        if (rawData?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity) {
            const activities = rawData.Siri.ServiceDelivery.VehicleMonitoringDelivery[0].VehicleActivity;
            rawData.Siri.ServiceDelivery.VehicleMonitoringDelivery[0].VehicleActivity = activities.filter(v => {
                const lineRef = v.MonitoredVehicleJourney?.LineRef?.value;
                if (!lineRef) return false;
                const parts = lineRef.split(':');
                const lineName = parts.slice(1).find(p => p && p !== 'Line') || parts[0];
                return lineName && !lineName.startsWith('JD');
            });
        }

        busCache = rawData;
        busLastFetch = now;
        res.json(busCache);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * Récupère les alertes trafic.
 * Cache de 2 minutes.
 */
app.get('/api/alerts', async (req, res) => {
    const now = Date.now();
    if (alertsCache && (now - alertsLastFetch < ALERTS_TTL)) return res.json(alertsCache);
    try {
        const response = await fetch(ALERTS_URL, { headers: AUTH_HEADER });
        alertsCache = await response.json();
        alertsLastFetch = now;
        res.json(alertsCache);
    } catch (e) { res.status(500).json({ error: "Erreur alertes" }); }
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
 */
async function refreshAllArrivals() {
    try {
        const response = await fetch(ARRIVALS_URL, { headers: AUTH_HEADER });
        allArrivalsCache   = await response.json();
        allArrivalsFetchTs = Date.now();
    } catch (e) {
        console.warn('⚠️ Rafraîchissement passages échoué:', e.message);
    }
}

/**
 * Récupère les passages pour un arrêt spécifique à partir du cache global.
 */
app.get('/api/arrivals/:stopId', async (req, res) => {
    const stopId = parseInt(req.params.stopId, 10);
    if (!stopId) return res.status(400).json({ error: 'stopId invalide' });

    try {
        if (!allArrivalsCache) await refreshAllArrivals();

        const passages = (allArrivalsCache.values || [])
            .filter(p => p.id === stopId)
            .map(p => ({
                ligne:     p.ligne,
                direction: p.direction,
                delai:     p.delaipassage,
                heure:     p.heurepassage,
                type:      p.type,
            }))
            .sort((a, b) => new Date(a.heure) - new Date(b.heure));

        res.json({ stopId, passages });
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
        const resArrets  = await fetch(STOPS_URL, { headers: AUTH_HEADER });
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
            const resZones  = await fetch(ZONES_URL, { headers: AUTH_HEADER });
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
    console.log(`✅ Cache passages prêt (${(allArrivalsCache?.values?.length || 0)} entrées) !`);

    // 3. Rafraîchissement proactif en arrière-plan toutes les 15s
    setInterval(refreshAllArrivals, ALL_ARRIVALS_TTL);
    console.log(`🔄 Rafraîchissement automatique des passages toutes les ${ALL_ARRIVALS_TTL / 1000}s activé.`);
});
