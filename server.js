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

// Route pour le dictionnaire des arrêts
app.get('/api/stops', async (req, res) => {
    if (stopsCache) return res.json(stopsCache);
    try {
        console.log("⏳ Téléchargement du super-dictionnaire des arrêts...");
        let dict = {};
        
        // 1. On récupère les points d'arrêt
        try {
            const resArrets = await fetch(STOPS_URL, { headers: { 'Authorization': `Basic ${credentials}` } });
            const dataArrets = await resArrets.json();
            (dataArrets.values || []).forEach(a => { dict[a.id] = a.nom; });
        } catch(e) { console.log("⚠️ Impossible de charger les points d'arrêt"); }

        // 2. On récupère les zones d'arrêt (Crucial pour les destinations !)
        try {
            const resZones = await fetch(ZONES_URL, { headers: { 'Authorization': `Basic ${credentials}` } });
            const dataZones = await resZones.json();
            (dataZones.values || []).forEach(z => { dict[z.id] = z.nom; });
        } catch(e) { console.log("⚠️ Impossible de charger les zones d'arrêt"); }
        
        stopsCache = dict;
        console.log(`✅ Dictionnaire prêt avec ${Object.keys(dict).length} arrêts/zones !`);
        res.json(dict);
    } catch (e) {
        res.status(500).json({ error: "Erreur arrêts" });
    }
});

app.listen(PORT, () => console.log(`🚀 Serveur PRO : http://localhost:${PORT}`));