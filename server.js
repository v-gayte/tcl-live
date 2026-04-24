require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BUSES_URL = "https://data.grandlyon.com/siri-lite/2.0/vehicle-monitoring.json";
const ALERTS_URL = "https://data.grandlyon.com/fr/datapusher/ws/rdata/tcl_sytral.tclalertetrafic_2/all.json?maxfeatures=-1&start=1";

// URL des points d'arrêts TCL
const STOPS_URL = "https://data.grandlyon.com/fr/datapusher/ws/rdata/tcl_sytral.tclarret/all.json?maxfeatures=-1";
const ZONES_URL = "https://data.grandlyon.com/fr/datapusher/ws/rdata/tcl_sytral.tclzonearret/all.json?maxfeatures=-1";

const USERNAME = process.env.API_USER?.trim();
const PASSWORD = process.env.API_PASSWORD?.trim();
const credentials = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');

let busCache = null;
let stopsCache = null;
let busLastFetch = 0;

app.get('/api/buses', async (req, res) => {
    const now = Date.now();
    if (busCache && (now - busLastFetch < 15000)) return res.json(busCache);
    try {
        const response = await fetch(BUSES_URL, {
            headers: { 'Authorization': `Basic ${credentials}`, 'Accept': 'application/json' }
        });
        busCache = await response.json();
        busLastFetch = now;
        res.json(busCache);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/alerts', async (req, res) => {
    try {
        const response = await fetch(ALERTS_URL, {
            headers: { 'Authorization': `Basic ${credentials}` }
        });
        const data = await response.json();
        res.json(data);
    } catch (e) { res.status(500).json({ error: "Erreur alertes" }); }
});

// Route pour les arrêts (dictionnaire + données géographiques)
app.get('/api/stops', async (req, res) => {
    if (stopsCache) return res.json(stopsCache);
    try {
        console.log("⏳ Téléchargement des arrêts...");
        let dict = {};
        let geo = [];

        // 1. Points d'arrêt (avec coordonnées et desserte)
        try {
            const resArrets = await fetch(STOPS_URL, { headers: { 'Authorization': `Basic ${credentials}` } });
            const dataArrets = await resArrets.json();
            (dataArrets.values || []).forEach(a => {
                dict[a.id] = a.nom;
                if (a.lat && a.lon && a.desserte) {
                    // Parse desserte: "21:A,JD183:A,JD35:R" → ["21","JD183","JD35"]
                    const lines = [...new Set(
                        a.desserte.split(',').map(d => d.split(':')[0].trim()).filter(Boolean)
                    )];
                    if (lines.length > 0) {
                        geo.push({ id: a.id, nom: a.nom, lat: a.lat, lng: a.lon, lines });
                    }
                }
            });
        } catch(e) { console.log("⚠️ Impossible de charger les points d'arrêt"); }

        // 2. Zones d'arrêt (pour résolution des noms de destination)
        try {
            const resZones = await fetch(ZONES_URL, { headers: { 'Authorization': `Basic ${credentials}` } });
            const dataZones = await resZones.json();
            (dataZones.values || []).forEach(z => { dict[z.id] = z.nom; });
        } catch(e) { console.log("⚠️ Impossible de charger les zones d'arrêt"); }
        
        stopsCache = { dict, geo };
        console.log(`✅ ${Object.keys(dict).length} noms | ${geo.length} arrêts géolocalisés !`);
        res.json(stopsCache);
    } catch (e) {
        res.status(500).json({ error: "Erreur arrêts" });
    }
});

// Route prochains passages pour un arrêt donné
const ARRIVALS_URL = "https://data.grandlyon.com/fr/datapusher/ws/rdata/tcl_sytral.tclpassagearret/all.json?maxfeatures=-1&start=1";
const arrivalsCache = new Map(); // stopId → { data, ts }
const ARRIVALS_TTL = 10000; // 20 s

app.get('/api/arrivals/:stopId', async (req, res) => {
    const stopId = parseInt(req.params.stopId, 10);
    if (!stopId) return res.status(400).json({ error: 'stopId invalide' });

    const cached = arrivalsCache.get(stopId);
    if (cached && Date.now() - cached.ts < ARRIVALS_TTL) {
        return res.json(cached.data);
    }

    try {
        // The API doesn't support server-side filtering by stop id, so we fetch all and filter
        const response = await fetch(ARRIVALS_URL, {
            headers: { 'Authorization': `Basic ${credentials}`, 'Accept': 'application/json' }
        });
        const raw = await response.json();
        const passages = (raw.values || [])
            .filter(p => p.id === stopId)
            .map(p => ({
                ligne:        p.ligne,
                direction:    p.direction,
                delai:        p.delaipassage,
                heure:        p.heurepassage,
                type:         p.type,  // T=théorique, R=temps-réel
            }))
            .sort((a, b) => new Date(a.heure) - new Date(b.heure));

        const result = { stopId, passages };
        arrivalsCache.set(stopId, { data: result, ts: Date.now() });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: 'Erreur passages: ' + e.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Serveur PRO : http://localhost:${PORT}`));