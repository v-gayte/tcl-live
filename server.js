require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// URLs API Grand Lyon (Temps réel et Data alphanumérique)
const BUSES_URL = "https://data.grandlyon.com/siri-lite/2.0/vehicle-monitoring.json";
const ALERTS_URL = "https://data.grandlyon.com/fr/datapusher/ws/rdata/tcl_sytral.tclalertetrafic_2/all.json?maxfeatures=-1&start=1";
const STOPS_URL = "https://data.grandlyon.com/fr/datapusher/ws/rdata/tcl_sytral.tclarret/all.json?maxfeatures=-1";

// NOUVEAU : URLs WFS cartographiques standard (GeoJSON)
// Le WFS ne nécessite pas d'authentification et renvoie la géométrie native EPSG:4326
const BUS_ROUTES_URL = "https://download.data.grandlyon.com/wfs/sytral?SERVICE=WFS&VERSION=2.0.0&request=GetFeature&typename=sytral:tcl_sytral.tcllignebus_2_0_0&outputFormat=application/json&SRSNAME=EPSG:4326";
const TRAM_ROUTES_URL = "https://download.data.grandlyon.com/wfs/sytral?SERVICE=WFS&VERSION=2.0.0&request=GetFeature&typename=sytral:tcl_sytral.tcllignetram_2_0_0&outputFormat=application/json&SRSNAME=EPSG:4326";

const USERNAME = process.env.API_USER?.trim();
const PASSWORD = process.env.API_PASSWORD?.trim();
const credentials = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');

let busCache = null;
let stopsCache = null;
let routesCache = null; 
let busLastFetch = 0;

// API : Tracés des lignes via WFS (Format GeoJSON)
app.get('/api/routes', async (req, res) => {
    if (routesCache) return res.json(routesCache);
    try {
        console.log("⏳ Chargement des tracés via WFS...");
        // Pas besoin de headers d'authentification pour ce flux WFS public
        const [resBus, resTram] = await Promise.all([
            fetch(BUS_ROUTES_URL),
            fetch(TRAM_ROUTES_URL)
        ]);
        
        const busData = await resBus.json();
        const tramData = await resTram.json();

        // WFS renvoie une 'FeatureCollection', on extrait le tableau 'features'
        routesCache = {
            bus: busData.features || [],
            tram: tramData.features || []
        };
        console.log(`✅ Tracés chargés : ${routesCache.bus.length} bus, ${routesCache.tram.length} trams.`);
        res.json(routesCache);
    } catch (e) { 
        console.error("⚠️ Erreur tracés WFS:", e);
        res.status(500).json({ error: "Erreur tracés" }); 
    }
});

// API : Positions des bus (Temps réel)
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

// API : Arrêts
app.get('/api/stops', async (req, res) => {
    if (stopsCache) return res.json(stopsCache);
    try {
        let dict = {}; let geo = [];
        const resArrets = await fetch(STOPS_URL, { headers: { 'Authorization': `Basic ${credentials}` } });
        const dataArrets = await resArrets.json();
        (dataArrets.values || []).forEach(a => {
            dict[a.id] = a.nom;
            if (a.lat && a.lon && a.desserte) {
                const lines = [...new Set(a.desserte.split(',').map(d => d.split(':')[0].trim()).filter(Boolean))];
                if (lines.length > 0) geo.push({ id: a.id, nom: a.nom, lat: a.lat, lng: a.lon, lines });
            }
        });
        stopsCache = { dict, geo };
        res.json(stopsCache);
    } catch (e) { res.status(500).json({ error: "Erreur arrêts" }); }
});

// API : Passages
const ARRIVALS_URL = "https://data.grandlyon.com/fr/datapusher/ws/rdata/tcl_sytral.tclpassagearret/all.json?maxfeatures=-1";
app.get('/api/arrivals/:stopId', async (req, res) => {
    const stopId = parseInt(req.params.stopId, 10);
    try {
        const response = await fetch(ARRIVALS_URL, { headers: { 'Authorization': `Basic ${credentials}` } });
        const raw = await response.json();
        const passages = (raw.values || []).filter(p => p.id === stopId)
            .map(p => ({ ligne: p.ligne, direction: p.direction, delai: p.delaipassage, heure: p.heurepassage, type: p.type }))
            .sort((a, b) => new Date(a.heure) - new Date(b.heure));
        res.json({ stopId, passages });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/alerts', async (req, res) => {
    try {
        const response = await fetch(ALERTS_URL, { headers: { 'Authorization': `Basic ${credentials}` } });
        res.json(await response.json());
    } catch (e) { res.status(500).json({ error: "Erreur alertes" }); }
});

app.listen(PORT, () => console.log(`🚀 Serveur : http://localhost:${PORT}`));
