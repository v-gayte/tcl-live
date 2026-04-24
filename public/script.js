const map = L.map('map', { zoomControl: false }).setView([45.76, 4.83], 13);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap' }).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const busLayer = L.layerGroup().addTo(map);
const routesLayer = L.layerGroup().addTo(map); // Calque pour les tracés
const stopsLayer = L.layerGroup();

let allRoutesData = { bus: [], tram: [] }; 
let userMarker = null, userPosition = null;
let activeFilters = new Set(), knownLines = new Set();
let dictStops = {}, allStopsGeo = [];
let currentStopInterval = null;

// 1. Charger les TRACÉS depuis notre API WFS
fetch('/api/routes')
    .then(res => {
        if (!res.ok) throw new Error("Erreur de chargement des tracés");
        return res.json();
    })
    .then(data => {
        allRoutesData = data;
        drawFilteredRoutes(); 
        console.log("✅ Tracés WFS chargés !");
    })
    .catch(e => console.error("⚠️", e));

// 2. Charger les ARRÊTS
fetch('/api/stops')
    .then(res => res.json())
    .then(data => {
        dictStops = data.dict; allStopsGeo = data.geo;
        buildStopsLayer();
    });

// 3. Fonction pour dessiner les tracés filtrés
function drawFilteredRoutes() {
    routesLayer.clearLayers(); // Efface la carte
    
    const draw = (features, color, weight, opacity) => {
        features.forEach(feature => {
            // Dans un GeoJSON, les données de la ligne sont dans 'properties'
            const props = feature.properties;
            // Sécurité : l'API TCL appelle parfois ça 'ligne' ou 'code_ligne'
            const lineName = props.ligne || props.code_ligne || props.nom; 
            
            // Si on a des filtres actifs et que cette ligne n'y est pas, on ignore le tracé
            if (activeFilters.size > 0 && !activeFilters.has(lineName)) return;

            L.geoJSON(feature, {
                style: { color, weight, opacity },
                interactive: false
            }).addTo(routesLayer);
        });
    };

    draw(allRoutesData.bus, '#888888', 2, 0.4);
    draw(allRoutesData.tram, '#E2001A', 4, 0.6);
}

// Construction des arrêts 
function buildStopsLayer() {
    stopsLayer.clearLayers();
    allStopsGeo.forEach(stop => {
        if (activeFilters.size > 0 && !stop.lines.some(l => activeFilters.has(l))) return;

        const m = L.circleMarker([stop.lat, stop.lng], {
            radius: 8, fillColor: '#555', color: '#fff', weight: 2, fillOpacity: 0.6
        });

        const popupId = `arrivals-${stop.id}`;
        m.bindPopup(`
            <div style="min-width:200px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <b>${stop.nom}</b>
                    <button id="refresh-stop-${stop.id}" class="refresh-btn">🔄</button>
                </div>
                <hr style="border:0;border-top:1px solid #eee;margin:8px 0;">
                <div id="${popupId}">⏳ Chargement...</div>
            </div>`);

        m.on('popupopen', () => {
            const fetchArr = async () => {
                const el = document.getElementById(popupId);
                const btn = document.getElementById(`refresh-stop-${stop.id}`);
                if (btn) btn.classList.add('spin-anim');
                try {
                    const res = await fetch(`/api/arrivals/${stop.id}`);
                    const data = await res.json();
                    el.innerHTML = data.passages.length ? data.passages.slice(0,5).map(p => `
                        <div style="display:flex;gap:5px;font-size:0.85em;padding:2px 0;">
                            <span style="background:#E2001A;color:#fff;padding:0 4px;border-radius:3px;font-weight:700;">${p.ligne}</span>
                            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.direction}</span>
                            <b style="${p.type==='R'?'color:#E2001A':''}">${p.delai}</b>
                        </div>`).join('') : '<i>Aucun passage</i>';
                } catch(e) { el.innerHTML = "Erreur"; }
                if (btn) setTimeout(() => btn.classList.remove('spin-anim'), 500);
            };
            fetchArr();
            if (currentStopInterval) clearInterval(currentStopInterval);
            currentStopInterval = setInterval(fetchArr, 15000);
            document.getElementById(`refresh-stop-${stop.id}`).onclick = fetchArr;
        });
        m.on('popupclose', () => clearInterval(currentStopInterval));
        stopsLayer.addLayer(m);
    });
    toggleStopsVisibility();
}

function toggleStopsVisibility() {
    if (map.getZoom() >= 14) { if (!map.hasLayer(stopsLayer)) map.addLayer(stopsLayer); }
    else { if (map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer); }
}
map.on('zoomend', toggleStopsVisibility);

// Géolocalisation
let isTracking = false;
document.getElementById('locate-btn').onclick = () => {
    if (!isTracking) {
        isTracking = true;
        document.getElementById('locate-btn').style.color = '#E2001A';
        map.locate({ watch: true, enableHighAccuracy: true });
    } else if (userPosition) {
        map.setView([userPosition.lat, userPosition.lng], 16);
    }
};
map.on('locationfound', (e) => {
    userPosition = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (!userMarker) userMarker = L.circleMarker(e.latlng, { radius: 8, fillColor: '#007bff', color: '#fff', weight: 3, fillOpacity: 1 }).addTo(map);
    else userMarker.setLatLng(e.latlng);
});

// Mise à jour des Bus
async function updateBuses() {
    try {
        const res = await fetch('/api/buses');
        const data = await res.json();
        const vehicles = data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity || [];
        busLayer.clearLayers();
        vehicles.forEach(v => {
            const j = v.MonitoredVehicleJourney;
            const line = j.LineRef.value.split('::')[1]?.split(':')[0] || j.LineRef.value;
            knownLines.add(line);
            
            if (activeFilters.size > 0 && !activeFilters.has(line)) return;
            
            // Calcul de la flèche de direction (si présente dans l'API)
            const bearing = j.Bearing;
            const hasBearing = bearing !== undefined && bearing !== null;
            const isZoomedOut = map.getZoom() < 14;
            const ARROW_H = isZoomedOut ? 0 : 12;
            const size = isZoomedOut ? 16 : 32;
            const arrowSVG = hasBearing && !isZoomedOut ? `<div style="position:absolute;top:0;left:50%;transform:translateX(-50%) rotate(${bearing}deg);transform-origin:center ${ARROW_H + size / 2}px;"><svg width="12" height="${ARROW_H + 2}"><polygon points="6,0 10,${ARROW_H + 2} 2,${ARROW_H + 2}" fill="white" stroke="#E2001A" stroke-width="1.5"/></svg></div>` : '';

            const icon = L.divIcon({
                className: 'custom-bus-icon',
                html: `<div style="position:relative; width:${size}px; height:${size + ARROW_H}px; overflow:visible;">
                        ${arrowSVG}
                        <div class="bus-bubble" style="position:absolute;top:${ARROW_H}px;background:#E2001A;color:#fff;border-radius:50%;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;font-size:${isZoomedOut?'0':(line.length>2?'10px':'12px')};font-weight:bold;border:2px solid #fff;">${isZoomedOut?'':line}</div>
                    </div>`,
                iconSize: [size, size + ARROW_H],
                iconAnchor: [size / 2, size + ARROW_H - size / 2]
            });
            
            L.marker([j.VehicleLocation.Latitude, j.VehicleLocation.Longitude], { icon }).addTo(busLayer);
        });
        document.getElementById('update-text').innerText = `${new Date().toLocaleTimeString()} • ${vehicles.length} véhicules`;
    } catch(e) {}
}

// Filtres
document.getElementById('filter-btn').onclick = () => {
    const list = document.getElementById('filter-list');
    list.innerHTML = "";
    const lines = Array.from(knownLines).sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));
    
    lines.forEach(line => {
        const btn = document.createElement('button');
        btn.className = `line-btn ${activeFilters.has(line)?'active':''}`;
        btn.innerText = line;
        btn.onclick = () => {
            if (activeFilters.has(line)) activeFilters.delete(line);
            else activeFilters.add(line);
            syncUI();
        };
        list.appendChild(btn);
    });
    document.getElementById('filter-modal').classList.remove('hidden');
};

function syncUI() {
    document.getElementById('filter-btn').innerText = activeFilters.size === 0 ? '🚍 Filtrer' : `🚍 ${activeFilters.size} sélectionnés`;
    updateBuses();
    buildStopsLayer();
    drawFilteredRoutes(); // Relance le dessin des tracés
}

document.getElementById('close-filters').onclick = () => document.getElementById('filter-modal').classList.add('hidden');
map.on('zoomend', updateBuses);
setInterval(updateBuses, 15000);
updateBuses();
