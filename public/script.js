const map = L.map('map', { zoomControl: false }).setView([45.76, 4.83], 13);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap'
}).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const busLayer = L.layerGroup().addTo(map);
const routesLayer = L.layerGroup().addTo(map); // Nouveau calque pour les tracés

let userMarker = null;
let userPosition = null; // { lat, lng } — updated on geolocation
let activeFilters = new Set();
let knownLines = new Set();
let busPositionsByLine = {};  // still used for live counts

// --- DONNÉES STATIQUES ---
let dictStops = {};
let allStopsGeo = [];   // [{id, nom, lat, lng, lines: ["C3","70"]}, …]
const stopsLayer = L.layerGroup(); // added to map conditionally by zoom

// 1. Charger et afficher les tracés des BUS
fetch('/bus.geojson')
    .then(async res => {
        if (!res.ok) throw new Error("Fichier bus.geojson introuvable");
        const data = await res.json();
        L.geoJSON(data, {
            style: { color: '#888888', weight: 2, opacity: 0.3 },
            interactive: false
        }).addTo(routesLayer);
        console.log("✅ Tracés Bus chargés !");
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
        console.log("✅ Tracés Tram chargés !");
    }).catch(e => console.error("⚠️ Erreur Tram GeoJSON:", e));

// 3. Charger les arrêts (dictionnaire + géo)
fetch('/api/stops')
    .then(res => res.json())
    .then(data => {
        dictStops = data.dict || data;  // backward compatible
        allStopsGeo = data.geo || [];
        console.log(`✅ ${Object.keys(dictStops).length} noms | ${allStopsGeo.length} arrêts géo`);
        // Build the stops markers (small grey dots)
        buildStopsLayer();
    }).catch(e => console.error("⚠️ Erreur chargement arrêts:", e));

let proximityCircle = null; // dashed 500m circle around user

// --- DISTANCE (Haversine) — déclaré tôt, utilisé par buildStopsLayer ---
function distanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
            * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Build stop markers on the map
function buildStopsLayer() {
    stopsLayer.clearLayers();
    allStopsGeo.forEach(stop => {
        const isNearby = userPosition &&
            distanceMeters(userPosition.lat, userPosition.lng, stop.lat, stop.lng) <= 500;

        const m = L.circleMarker([stop.lat, stop.lng], {
            radius:      isNearby ? 6 : 4,
            fillColor:   isNearby ? '#E2001A' : '#555',
            color:       '#fff',
            weight:      isNearby ? 2 : 1,
            fillOpacity: isNearby ? 0.9 : 0.55,
            opacity:     0.9,
            zIndexOffset: isNearby ? 100 : 0,
        });

        const linesHtml = stop.lines
            .map(l => `<span style="display:inline-block;background:#E2001A;color:#fff;border-radius:4px;padding:1px 6px;margin:2px;font-size:0.8em;font-weight:700;">${l}</span>`)
            .join('');

        m.bindPopup(`
            <div style="min-width:140px;">
                <b style="font-size:1em;">${stop.nom}</b>
                ${isNearby ? '<span style="float:right;font-size:0.75em;color:#E2001A;">📍 < 500 m</span>' : ''}
                <br><div style="margin-top:6px;">${linesHtml}</div>
            </div>`);
        stopsLayer.addLayer(m);
    });
    toggleStopsVisibility();
}

function toggleStopsVisibility() {
    if (map.getZoom() >= 14) {
        if (!map.hasLayer(stopsLayer)) map.addLayer(stopsLayer);
    } else {
        if (map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer);
    }
}
map.on('zoomend', toggleStopsVisibility);

// --- GÉOLOCALISATION ---
document.getElementById('locate-btn').onclick = () => map.locate({ setView: true, maxZoom: 16 });
map.on('locationfound', (e) => {
    userPosition = { lat: e.latlng.lat, lng: e.latlng.lng };

    // Update or create user position marker
    if (!userMarker) {
        userMarker = L.circleMarker(e.latlng, {
            radius: 8, fillColor: '#007bff', color: '#fff', weight: 3, fillOpacity: 1
        }).addTo(map);
    } else {
        userMarker.setLatLng(e.latlng);
    }

    // Draw/update 500m proximity circle
    if (proximityCircle) map.removeLayer(proximityCircle);
    proximityCircle = L.circle(e.latlng, {
        radius: 500,
        color: '#007bff', weight: 1.5,
        dashArray: '6 5',
        fillColor: '#007bff', fillOpacity: 0.04,
    }).addTo(map);

    // Rebuild stops to update nearby highlighting
    if (allStopsGeo.length > 0) buildStopsLayer();
});


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
        const tempPositions = {}; // collect positions per line this refresh

        vehicles.forEach(v => {
            const journey = v.MonitoredVehicleJourney;
            const line = formatLine(journey.LineRef.value);
            knownLines.add(line);

            if (activeFilters.size > 0 && !activeFilters.has(line)) return;

            const lat = journey.VehicleLocation.Latitude;
            const lng = journey.VehicleLocation.Longitude;
            visibleCount++;

            // Track bus positions per line for proximity filter
            if (!tempPositions[line]) tempPositions[line] = [];
            tempPositions[line].push({ lat, lng });

            // ── Direction arrow ──────────────────────────────────────────
            // SIRI provides Bearing as degrees from North (0 = North, 90 = East …)
            const bearing = journey.Bearing; // number or undefined
            const hasBearing = bearing !== undefined && bearing !== null;

            const isZoomedOut = currentZoom < 14;
            const size = isZoomedOut ? 16 : 32;
            const text = isZoomedOut ? '' : line;

            // Arrow height above the bubble in px (hidden when zoomed out)
            const ARROW_H = isZoomedOut ? 0 : 12;

            // Total icon wrapper dimensions
            const wrapperW = size;
            const wrapperH = size + ARROW_H;

            // Build SVG arrow (pointing UP = North by default)
            // We rotate the entire .bus-arrow element around its bottom-center
            // which coincides with the bubble center → perfect compass rotation.
            const arrowSVG = hasBearing && !isZoomedOut ? `
                <div class="bus-arrow" style="
                    transform: translateX(-50%) rotate(${bearing}deg);
                    transform-origin: center ${ARROW_H + size / 2}px;
                ">
                    <svg width="12" height="${ARROW_H + 2}" viewBox="0 0 12 ${ARROW_H + 2}"
                         xmlns="http://www.w3.org/2000/svg">
                        <!-- Arrowhead at top, shaft going down -->
                        <polygon points="6,0 10,${ARROW_H + 2} 2,${ARROW_H + 2}"
                                 fill="white" stroke="#E2001A" stroke-width="1.5"
                                 stroke-linejoin="round"/>
                    </svg>
                </div>` : '';

            // Font size scales with line-number length
            const fontSize = line.length > 2 ? '10px' : line.length > 1 ? '12px' : '14px';

            const busIcon = L.divIcon({
                className: 'custom-bus-icon',
                html: `
                    <div style="position:relative; width:${wrapperW}px; height:${wrapperH}px; overflow:visible;">
                        ${arrowSVG}
                        <div class="bus-bubble" style="top:${ARROW_H}px;">
                            <span style="font-size:${fontSize}; line-height:1;">${text}</span>
                        </div>
                    </div>`,
                iconSize:   [wrapperW, wrapperH],
                iconAnchor: [wrapperW / 2, wrapperH - size / 2], // anchor = centre de la bulle
            });

            // ── Popup content ────────────────────────────────────────────
            const destinationPrecise = getStopName(journey.DestinationRef?.value, journey.DestinationName);
            const prochainArret = getStopName(journey.MonitoredCall?.StopPointRef?.value, journey.MonitoredCall?.StopPointName);

            L.marker([lat, lng], { icon: busIcon }).addTo(busLayer)
             .bindPopup(`
                <div style="text-align:center; min-width:160px;">
                    <b style="font-size:1.2em; color:#E2001A;">Ligne ${line}</b>
                    <br>
                    <span style="color:#555;">Vers : <b>${destinationPrecise}</b></span>
                </div>
                <hr style="border:0; border-top:1px solid #ddd; margin:8px 0;">
                <div>📍 Prochain arrêt :<br><b>${prochainArret}</b></div>
             `);
        });

        busPositionsByLine = tempPositions;
        document.getElementById('update-text').innerText = `${new Date().toLocaleTimeString('fr-FR')} • ${visibleCount} bus`;
    } catch (e) { console.error(e); }
}

// --- FILTRES MULTIPLES ---
const filterModal = document.getElementById('filter-modal');

document.getElementById('filter-btn').onclick = () => {
    const list = document.getElementById('filter-list');
    list.innerHTML = "";
    
    // "Toutes" button
    const btnAll = document.createElement('button');
    btnAll.className = `line-btn ${activeFilters.size === 0 ? 'active' : ''}`;
    btnAll.innerText = "Toutes";
    btnAll.onclick = () => { 
        activeFilters.clear(); 
        syncUI(); 
        updateBuses();
    };
    list.appendChild(btnAll);

    // Merge known bus lines with all lines from stops (so we see lines even without active buses)
    const allLinesSet = new Set(knownLines);
    allStopsGeo.forEach(s => s.lines.forEach(l => allLinesSet.add(l)));
    const allLines = Array.from(allLinesSet);

    let nearbyLines = [];
    let otherLines = [];

    if (userPosition && allStopsGeo.length > 0) {
        // Find stops within 500m and extract lines
        const nearbyStops = allStopsGeo
            .map(s => ({ ...s, dist: distanceMeters(userPosition.lat, userPosition.lng, s.lat, s.lng) }))
            .filter(s => s.dist <= 500);

        // For each line, find the closest stop that serves it
        const nearbyLinesMap = new Map(); // line → min distance
        nearbyStops.forEach(s => {
            s.lines.forEach(line => {
                const prev = nearbyLinesMap.get(line) || Infinity;
                if (s.dist < prev) nearbyLinesMap.set(line, s.dist);
            });
        });

        // All nearby lines sorted by distance
        nearbyLines = Array.from(nearbyLinesMap.entries())
            .map(([line, minDist]) => ({ line, minDist }))
            .sort((a, b) => a.minDist - b.minDist);

        const nearbyLineNames = new Set(nearbyLines.map(l => l.line));

        // Other lines = not nearby, sorted alphanumerically
        otherLines = allLines
            .filter(l => !nearbyLineNames.has(l))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .map(line => ({ line, minDist: Infinity }));
    } else {
        // No location → all lines in normal order
        otherLines = allLines
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .map(line => ({ line, minDist: Infinity }));
    }

    // Helper to create a line button
    function makeLineBtn(line, distLabel) {
        const btn = document.createElement('button');
        btn.className = `line-btn ${activeFilters.has(line) ? 'active' : ''}`;
        btn.innerHTML = distLabel 
            ? `${line}<span class="line-dist">${distLabel}</span>` 
            : line;
        btn.dataset.line = line;
        btn.onclick = () => {
            if (activeFilters.has(line)) activeFilters.delete(line);
            else activeFilters.add(line);
            syncUI();
            updateBuses();
        };
        return btn;
    }

    // Section: nearby stops
    if (nearbyLines.length > 0) {
        const count = allStopsGeo.filter(s => distanceMeters(userPosition.lat, userPosition.lng, s.lat, s.lng) <= 500).length;
        const header = document.createElement('div');
        header.className = 'filter-section-header';
        header.innerHTML = `📍 À proximité <small>(${count} arrêts à < 500 m)</small>`;
        list.appendChild(header);

        const nearbyGrid = document.createElement('div');
        nearbyGrid.className = 'filter-grid';
        nearbyLines.forEach(({ line, minDist }) => {
            const dist = minDist < 100 ? `${Math.round(minDist)} m` : `${Math.round(minDist / 10) * 10} m`;
            nearbyGrid.appendChild(makeLineBtn(line, dist));
        });
        list.appendChild(nearbyGrid);
    }

    // Section: all others
    if (otherLines.length > 0) {
        const header = document.createElement('div');
        header.className = 'filter-section-header';
        header.innerHTML = nearbyLines.length > 0 ? '🚍 Autres lignes' : '🚍 Toutes les lignes';
        list.appendChild(header);

        const otherGrid = document.createElement('div');
        otherGrid.className = 'filter-grid';
        otherLines.forEach(({ line }) => {
            otherGrid.appendChild(makeLineBtn(line, null));
        });
        list.appendChild(otherGrid);
    }

    filterModal.classList.remove('hidden');
};

function syncUI() {
    const mainBtn = document.getElementById('filter-btn');
    mainBtn.innerText = activeFilters.size === 0 ? '🚍 Filtrer' : `🚍 ${activeFilters.size} sélectionnés`;
    
    document.querySelectorAll('.line-btn').forEach(b => {
        const line = b.dataset.line; // uses data-line attribute
        if (!line) {
            // "Toutes" button has no data-line
            b.className = `line-btn ${activeFilters.size === 0 ? 'active' : ''}`;
        } else {
            b.className = `line-btn ${activeFilters.has(line) ? 'active' : ''}`;
        }
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