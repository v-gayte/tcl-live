const map = L.map('map', { zoomControl: false }).setView([45.76, 4.83], 13);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap'
}).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const busLayer = L.layerGroup().addTo(map);
const routesLayer = L.layerGroup().addTo(map); // Nouveau calque pour les tracés

let userMarker = null;
let activeFilters = new Set();
let knownLines = new Set();

// --- DONNÉES STATIQUES ---
let dictStops = {};

// 1. Charger et afficher les tracés des BUS
fetch('/bus.geojson')
    .then(async res => {
        if (!res.ok) throw new Error("Fichier bus.geojson introuvable");
        const data = await res.json();
        L.geoJSON(data, {
            style: { color: '#888888', weight: 2, opacity: 0.3 },
            interactive: false // Empêche de cliquer sur la ligne par erreur
        }).addTo(routesLayer);
        console.log("✅ Tracés Bus chargés avec succès !");
    }).catch(e => console.error("⚠️ Erreur Bus GeoJSON:", e));

// 2. Charger et afficher les tracés des TRAMS
fetch('/tram.geojson')
    .then(async res => {
        if (!res.ok) throw new Error("Fichier tram.geojson introuvable");
        const data = await res.json();
        L.geoJSON(data, {
            style: { color: '#E2001A', weight: 3, opacity: 0.5 },
            interactive: false
        }).addTo(routesLayer);
        console.log("✅ Tracés Tram chargés avec succès !");
    }).catch(e => console.error("⚠️ Erreur Tram GeoJSON:", e));

// 3. Charger le dictionnaire des arrêts
fetch('/api/stops')
    .then(res => res.json())
    .then(data => {
        dictStops = data;
        console.log(`✅ ${Object.keys(dictStops).length} arrêts chargés en mémoire`);
    }).catch(e => console.error("⚠️ Erreur chargement arrêts:", e));

// --- GÉOLOCALISATION ---
document.getElementById('locate-btn').onclick = () => map.locate({ setView: true, maxZoom: 16 });
map.on('locationfound', (e) => {
    if (!userMarker) {
        userMarker = L.circleMarker(e.latlng, { radius: 8, fillColor: '#007bff', color: '#fff', weight: 3, fillOpacity: 1 }).addTo(map);
    } else {
        userMarker.setLatLng(e.latlng);
    }
});

// --- DESSIN DES TRACÉS ---
function drawActiveRoutes() {
    routesLayer.clearLayers();
    // On ne dessine les lignes que si un filtre spécifique est activé (pour éviter une carte illisible)
    if (activeFilters.size > 0 && geojsonLignes) {
        L.geoJSON(geojsonLignes, {
            filter: function(feature) {
                // Selon le GeoJSON de DGL, la propriété s'appelle souvent 'ligne' ou 'code_ligne'
                const nomLigneGeo = feature.properties.ligne || feature.properties.code_ligne || feature.properties.code;
                return activeFilters.has(nomLigneGeo);
            },
            style: { color: '#E2001A', weight: 4, opacity: 0.5 } // Ligne rouge semi-transparente
        }).addTo(routesLayer);
    }
}

// --- GESTION DES BUS ---
function formatLine(val) {
    if(!val) return "?";
    return val.split('::')[1]?.split(':')[0] || val;
}

// Fonction ultra-robuste pour trouver le nom de l'arrêt
function getStopName(siriRef, siriNameObj) {
    // 1. Si le nom est fourni directement par le bus, on le prend !
    if (siriNameObj && siriNameObj[0] && siriNameObj[0].value) {
        return siriNameObj[0].value;
    }
    
    // 2. Sinon, on extrait l'ID et on cherche dans notre dictionnaire
    if (!siriRef) return "Inconnue";
    const stopId = siriRef.split(':')[3]; 
    return dictStops[stopId] || `Arrêt n°${stopId}`;
}

async function updateBuses() {
    try {
        const res = await fetch('/api/buses');
        const data = await res.json();
        const vehicles = data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity || [];
        
        busLayer.clearLayers();
        let visibleCount = 0;
        const currentZoom = map.getZoom();

        vehicles.forEach(v => {
            const journey = v.MonitoredVehicleJourney;
            const line = formatLine(journey.LineRef.value);
            knownLines.add(line);

            if (activeFilters.size > 0 && !activeFilters.has(line)) return;

            const lat = journey.VehicleLocation.Latitude;
            const lng = journey.VehicleLocation.Longitude;
            visibleCount++;

            const isZoomedOut = currentZoom < 14;
            const size = isZoomedOut ? 16 : 32;
            const text = isZoomedOut ? '' : line;

            // NOUVEAU : Récupération des arrêts précis !
            const destinationPrecise = getStopName(journey.DestinationRef?.value, journey.DestinationName);
            const prochainArret = getStopName(journey.MonitoredCall?.StopPointRef?.value, journey.MonitoredCall?.StopPointName);

            const busIcon = L.divIcon({
                className: 'custom-bus-icon',
                html: `<span style="font-size: ${line.length > 2 ? '10px' : '13px'}">${text}</span>`,
                iconSize: [size, size],
                iconAnchor: [size/2, size/2]
            });

            L.marker([lat, lng], { icon: busIcon }).addTo(busLayer)
             .bindPopup(`
                <div style="text-align:center;">
                    <b style="font-size:1.2em; color:#E2001A;">Ligne ${line}</b><br>
                    <span style="color:#555;">Vers : <b>${destinationPrecise}</b></span>
                </div>
                <hr style="border:0; border-top:1px solid #ddd; margin:8px 0;">
                <div>📍 Prochain arrêt :<br><b>${prochainArret}</b></div>
             `);
        });

        document.getElementById('update-text').innerText = `${new Date().toLocaleTimeString('fr-FR')} • ${visibleCount} bus`;
    } catch (e) { console.error(e); }
}

// --- FILTRES MULTIPLES ---
const filterModal = document.getElementById('filter-modal');

document.getElementById('filter-btn').onclick = () => {
    const list = document.getElementById('filter-list');
    list.innerHTML = "";
    
    const btnAll = document.createElement('button');
    btnAll.className = `line-btn ${activeFilters.size === 0 ? 'active' : ''}`;
    btnAll.innerText = "Toutes";
    btnAll.onclick = () => { 
        activeFilters.clear(); 
        syncUI(); 
        updateBuses();
    };
    list.appendChild(btnAll);

    Array.from(knownLines).sort((a,b) => a.localeCompare(b, undefined, {numeric: true})).forEach(line => {
        const btn = document.createElement('button');
        btn.className = `line-btn ${activeFilters.has(line) ? 'active' : ''}`;
        btn.innerText = line;
        btn.onclick = () => {
            if(activeFilters.has(line)) activeFilters.delete(line);
            else activeFilters.add(line);
            syncUI(); 
            updateBuses();
        };
        list.appendChild(btn);
    });
    filterModal.classList.remove('hidden');
};

function syncUI() {
    const mainBtn = document.getElementById('filter-btn');
    mainBtn.innerText = activeFilters.size === 0 ? '🚍 Filtrer' : `🚍 ${activeFilters.size} sélectionnés`;
    
    document.querySelectorAll('.line-btn').forEach(b => {
        const l = b.innerText;
        if(l === "Toutes") b.className = `line-btn ${activeFilters.size === 0 ? 'active' : ''}`;
        else b.className = `line-btn ${activeFilters.has(l) ? 'active' : ''}`;
    });
}

// --- ALERTES ---
function formatAlertDate(dateString) {
    if (!dateString) return "?";
    const parts = dateString.split(' ');
    if (parts.length !== 2) return dateString;
    const d = parts[0].split('-');
    const t = parts[1].split(':');
    return `${d[2]}/${d[1]}/${d[0]} à ${t[0]}h${t[1]}`;
}

document.getElementById('alert-btn').onclick = async () => {
    const list = document.getElementById('alert-list');
    document.getElementById('alert-modal').classList.remove('hidden');
    list.innerHTML = "Chargement des alertes...";
    
    try {
        const res = await fetch('/api/alerts');
        const data = await res.json();
        list.innerHTML = "";
        
        let alertes = data.values || [];
        if (activeFilters.size > 0) {
            alertes = alertes.filter(a => activeFilters.has(a.ligne_cli));
        }

        if (alertes.length === 0) {
            list.innerHTML = "✅ Aucun incident pour votre sélection.";
            return;
        }

        alertes.forEach(a => {
            const div = document.createElement('div');
            div.className = "alert-item";
            const debut = formatAlertDate(a.debut);
            const fin = formatAlertDate(a.fin);
            const ligneImpactee = a.ligne_cli || "Inconnue";
            const cleanMessage = a.message ? a.message.replace(/<[^>]*>?/gm, '') : 'Détails indisponibles';

            div.innerHTML = `
                <strong>${a.titre || 'Alerte Trafic'}</strong><br>
                <div class="alert-meta">🚍 Ligne ${ligneImpactee} | Du ${debut} au ${fin}</div>
                <p style="margin-top: 5px;">${cleanMessage}</p>
            `;
            list.appendChild(div);
        });
    } catch (e) { list.innerHTML = "Erreur de connexion."; }
};

document.getElementById('close-filters').onclick = () => filterModal.classList.add('hidden');
document.getElementById('close-alerts').onclick = () => document.getElementById('alert-modal').classList.add('hidden');

map.on('zoomend', updateBuses);
setInterval(updateBuses, 15000);
updateBuses();