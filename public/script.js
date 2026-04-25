const map = L.map('map', { zoomControl: false }).setView([45.76, 4.83], 13);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap' }).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const busLayer    = L.layerGroup().addTo(map);
const routesLayer = L.layerGroup().addTo(map);

let userMarker   = null;
let userPosition = null;
let activeFilters   = new Set();
let knownLines      = new Set();
let busPositionsByLine = {};

// --- DONNÉES STATIQUES ---
let dictStops   = {};
let allStopsGeo = [];
const stopsLayer = L.layerGroup();
let currentStopInterval = null;
let allRoutesData = { bus: [], tram: [] };

// [OPT #4] Tableau des marqueurs d'arrêts créés une seule fois
let allStopMarkers = [];

// --- FAVORIS (persistés en localStorage) ---
let favorites = new Set(JSON.parse(localStorage.getItem('tcl_favorites') || '[]'));

function saveFavorites() {
    localStorage.setItem('tcl_favorites', JSON.stringify([...favorites]));
}
function toggleFavorite(line) {
    if (favorites.has(line)) favorites.delete(line);
    else favorites.add(line);
    saveFavorites();
}
function updateFavBtn() {
    const btn = document.getElementById('fav-btn');
    if (!btn) return;
    if (favorites.size === 0) {
        btn.classList.add('fav-btn-hidden');
    } else {
        btn.classList.remove('fav-btn-hidden');
        btn.innerHTML = favorites.size > 1
            ? `⭐ <span class="fav-count">${favorites.size}</span>`
            : '⭐';
    }
}

// --- CHARGEMENT DES DONNÉES ---

// Arrêts : chargés immédiatement (donnée critique pour l'affichage et les popups)
fetch('/api/stops')
    .then(res => res.json())
    .then(data => {
        dictStops   = data.dict || data;
        allStopsGeo = data.geo  || [];
        buildStopsLayer();
    }).catch(e => console.error("⚠️ Erreur chargement arrêts:", e));

// [OPT #3] Tracés WFS : chargement différé (lazy) pour ne pas bloquer le rendu initial
// requestIdleCallback attend que le navigateur ait affiché la carte avant de charger
function loadRoutes() {
    fetch('/api/routes')
        .then(res => res.json())
        .then(data => {
            allRoutesData = data;
            drawFilteredRoutes();
        }).catch(e => console.error("⚠️ Erreur tracés:", e));
}

if ('requestIdleCallback' in window) {
    requestIdleCallback(loadRoutes, { timeout: 3000 });
} else {
    setTimeout(loadRoutes, 500); // Fallback pour Safari
}

// --- TRACÉS WFS ---
function drawFilteredRoutes() {
    routesLayer.clearLayers();

    const draw = (features, color, weight, opacity) => {
        features.forEach(feature => {
            const props    = feature.properties;
            const lineName = props.ligne || props.code_ligne || props.nom;

            if (activeFilters.size > 0 && !activeFilters.has(lineName)) return;

            L.geoJSON(feature, {
                style: { color, weight, opacity },
                interactive: false
            }).addTo(routesLayer);
        });
    };

    draw(allRoutesData.bus,  '#888888', 2, 0.3);
    draw(allRoutesData.tram, '#E2001A', 3, 0.5);
}

// --- UTILITAIRES ---
function distanceMeters(lat1, lng1, lat2, lng2) {
    const R    = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
               + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
               * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- MARQUEURS D'ARRÊTS ---

// [OPT #4] buildStopsLayer crée les marqueurs UNE SEULE FOIS puis délègue à filterStopsVisibility
function buildStopsLayer() {
    // Si les marqueurs existent déjà, on se contente de filtrer leur visibilité
    if (allStopMarkers.length > 0) {
        filterStopsVisibility();
        toggleStopsVisibility();
        return;
    }

    // Première construction : on crée tous les marqueurs et on les stocke
    allStopsGeo.forEach(stop => {
        const linesHtml = stop.lines.map(l => {
            const active = activeFilters.size === 0 || activeFilters.has(l);
            return `<span style="display:inline-block;background:${active ? '#E2001A' : '#999'};color:#fff;border-radius:4px;padding:1px 6px;margin:2px;font-size:0.8em;font-weight:700;">${l}</span>`;
        }).join('');

        const popupId = `arrivals-${stop.id}`;

        const m = L.circleMarker([stop.lat, stop.lng], {
            radius: 6, fillColor: '#555', color: '#fff',
            weight: 2, fillOpacity: 0.6, opacity: 0.9,
        });

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
            const el  = document.getElementById(popupId);
            const btn = document.getElementById(`refresh-stop-${stop.id}`);

            const fetchArrivals = async () => {
                if (!el) return;
                if (btn) btn.classList.add('spin-anim');
                try {
                    const res  = await fetch(`/api/arrivals/${stop.id}`);
                    const data = await res.json();
                    const passages = data.passages || [];
                    if (passages.length === 0) {
                        el.innerHTML = '<i style="color:#aaa;">Aucun passage prévu</i>';
                    } else {
                        el.innerHTML = passages.slice(0, 6).map(p => {
                            const isRT       = p.type === 'R';
                            const delaiStyle = isRT ? 'color:#E2001A;font-weight:700;' : 'color:#777;';
                            const rtBadge    = isRT ? '<span style="font-size:0.7em;background:#E2001A;color:#fff;border-radius:3px;padding:0 4px;margin-left:4px;">Temps réel</span>' : '';
                            const heure      = p.heure ? p.heure.split(' ')[1]?.slice(0, 5) : '—';
                            return `
                                <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #f0f0f0;">
                                    <span style="background:#E2001A;color:#fff;border-radius:4px;padding:1px 6px;font-weight:700;font-size:0.85em;white-space:nowrap;">${p.ligne}</span>
                                    <span style="flex:1;color:#333;font-size:0.85em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${p.direction}">${p.direction}</span>
                                    <span style="${delaiStyle}white-space:nowrap;">${p.delai}${rtBadge}</span>
                                    <span style="color:#aaa;font-size:0.8em;white-space:nowrap;">${heure}</span>
                                </div>`;
                        }).join('');
                    }
                } catch (e) {
                    if (el) el.innerHTML = '<i style="color:#c00;">Erreur de chargement</i>';
                }
                if (btn) setTimeout(() => btn.classList.remove('spin-anim'), 500);
            };

            fetchArrivals();
            if (btn) btn.onclick = fetchArrivals;

            if (currentStopInterval) clearInterval(currentStopInterval);
            currentStopInterval = setInterval(fetchArrivals, 15000);
        });

        m.on('popupclose', () => {
            if (currentStopInterval) {
                clearInterval(currentStopInterval);
                currentStopInterval = null;
            }
        });

        allStopMarkers.push({ marker: m, stop });
    });

    filterStopsVisibility();
    toggleStopsVisibility();
}

// [OPT #4] Applique le filtre actif sur les marqueurs existants (pas de recréation)
function filterStopsVisibility() {
    stopsLayer.clearLayers();
    allStopMarkers.forEach(({ marker, stop }) => {
        if (activeFilters.size === 0 || stop.lines.some(l => activeFilters.has(l))) {
            stopsLayer.addLayer(marker);
        }
    });
}

function toggleStopsVisibility() {
    if (map.getZoom() >= 14) { if (!map.hasLayer(stopsLayer)) map.addLayer(stopsLayer); }
    else { if (map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer); }
}
map.on('zoomend', toggleStopsVisibility);

// Géolocalisation
let isTracking = false;
let isTrackingLocation = false;
let firstLocationFound = false;
document.getElementById('locate-btn').onclick = () => {
    if (!isTrackingLocation) {
        isTrackingLocation = true;
        document.getElementById('locate-btn').style.color = 'var(--tcl-red)';
        map.locate({ watch: true, setView: false, enableHighAccuracy: true });

        if (userPosition) map.setView([userPosition.lat, userPosition.lng], 16);
    } else {
        if (userPosition) {
            map.setView([userPosition.lat, userPosition.lng], 16);
        }
    }
};
map.on('locationfound', (e) => {
    userPosition = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (!userMarker) {
        userMarker = L.circleMarker(e.latlng, {
            radius: 8, fillColor: '#007bff', color: '#fff', weight: 3, fillOpacity: 1
        }).addTo(map);
    } else {
        userMarker.setLatLng(e.latlng);
    }

    if (!firstLocationFound && isTrackingLocation) {
        map.setView(e.latlng, 16);
        firstLocationFound = true;
    }
});

// --- GESTION DES BUS ---
function formatLine(val) {
    if (!val) return "?";
    return val.split('::')[1]?.split(':')[0] || val;
}

function getStopName(siriRef, siriNameObj) {
    if (siriNameObj && siriNameObj[0] && siriNameObj[0].value) return siriNameObj[0].value;
    if (!siriRef) return "Inconnue";
    const stopId = siriRef.split(':')[3];
    return dictStops[stopId] || `Arrêt n°${stopId}`;
}

async function updateBuses() {
    try {
        const res      = await fetch('/api/buses');
        const data     = await res.json();
        const vehicles = data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity || [];

        busLayer.clearLayers();
        let visibleCount = 0;
        const currentZoom  = map.getZoom();
        const tempPositions = {};

        vehicles.forEach(v => {
            const journey = v.MonitoredVehicleJourney;
            const line    = formatLine(journey.LineRef.value);
            knownLines.add(line);
            
            if (activeFilters.size > 0 && !activeFilters.has(line)) return;

            const lat = journey.VehicleLocation.Latitude;
            const lng = journey.VehicleLocation.Longitude;
            visibleCount++;

            if (!tempPositions[line]) tempPositions[line] = [];
            tempPositions[line].push({ lat, lng });

            const bearing    = journey.Bearing;
            const hasBearing = bearing !== undefined && bearing !== null;

            const isZoomedOut = currentZoom < 14;
            const size    = isZoomedOut ? 16 : 32;
            const ARROW_H = isZoomedOut ? 0 : 12;
            const wrapperW = size;
            const wrapperH = size + ARROW_H;
            const arrowSVG = hasBearing && !isZoomedOut ? `<div style="position:absolute;top:0;left:50%;transform:translateX(-50%) rotate(${bearing}deg);transform-origin:center ${ARROW_H + size / 2}px;"><svg width="12" height="${ARROW_H + 2}"><polygon points="6,0 10,${ARROW_H + 2} 2,${ARROW_H + 2}" fill="white" stroke="#E2001A" stroke-width="1.5"/></svg></div>` : '';

            const busIcon = L.divIcon({
                className: 'custom-bus-icon',
                html: `<div style="position:relative; width:${wrapperW}px; height:${wrapperH}px; overflow:visible;">
                        ${arrowSVG}
                        <div class="bus-bubble" style="position:absolute;top:${ARROW_H}px;background:#E2001A;color:#fff;border-radius:50%;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;font-size:${isZoomedOut?'0':(line.length>2?'10px':'12px')};font-weight:bold;border:2px solid #fff;">${isZoomedOut?'':line}</div>
                    </div>`,
                iconSize:   [wrapperW, wrapperH],
                iconAnchor: [wrapperW / 2, wrapperH - size / 2],
            });

            const destinationPrecise = getStopName(journey.DestinationRef?.value, journey.DestinationName);
            const prochainArret      = getStopName(journey.MonitoredCall?.StopPointRef?.value, journey.MonitoredCall?.StopPointName);

            L.marker([lat, lng], { icon: busIcon }).addTo(busLayer)
             .bindPopup(`
                <div style="text-align:center; min-width:160px;">
                    <b style="font-size:1.2em; color:#E2001A;">Ligne ${line}</b><br>
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

// Crée un bouton de ligne avec étoile favori intégrée
function makeLineBtn(line, distLabel) {
    const btn = document.createElement('button');
    btn.className    = `line-btn ${activeFilters.has(line) ? 'active' : ''}`;
    btn.dataset.line = line;

    // Étoile favori (coin supérieur gauche) — stopPropagation pour ne pas déclencher le filtre
    const star = document.createElement('span');
    star.className = `fav-star${favorites.has(line) ? ' starred' : ''}`;
    star.textContent = favorites.has(line) ? '★' : '☆';
    star.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(line);
        star.className   = `fav-star${favorites.has(line) ? ' starred' : ''}`;
        star.textContent = favorites.has(line) ? '★' : '☆';
        updateFavBtn();
        buildFilterList(); // Reconstruit le modal pour mettre à jour la section favoris
    });
    btn.appendChild(star);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = line;
    btn.appendChild(nameSpan);

    if (distLabel) {
        const dist = document.createElement('span');
        dist.className   = 'line-dist';
        dist.textContent = distLabel;
        btn.appendChild(dist);
    }
    btn.addEventListener('click', () => {
        if (activeFilters.has(line)) activeFilters.delete(line);
        else activeFilters.add(line);
        syncUI();
        updateBuses();
    });
    return btn;
}

// Construit (ou reconstruit) le contenu du modal filtre
function buildFilterList() {
    const list = document.getElementById('filter-list');
    list.innerHTML = '';

    // Bouton "Toutes"
    const btnAll = document.createElement('button');
    btnAll.className = `line-btn ${activeFilters.size === 0 ? 'active' : ''}`;
    btnAll.innerText = 'Toutes';
    btnAll.onclick   = () => { activeFilters.clear(); syncUI(); updateBuses(); };
    list.appendChild(btnAll);

    const allLines = Array.from(knownLines);
    let nearbyLines = [], otherLines = [];

    if (userPosition && allStopsGeo.length > 0) {
        const nearbyStops = allStopsGeo
            .map(s => ({ ...s, dist: distanceMeters(userPosition.lat, userPosition.lng, s.lat, s.lng) }))
            .filter(s => s.dist <= 500);
        const nearbyLinesMap = new Map();
        nearbyStops.forEach(s => s.lines.forEach(line => {
            if (knownLines.has(line)) {
                const prev = nearbyLinesMap.get(line) || Infinity;
                if (s.dist < prev) nearbyLinesMap.set(line, s.dist);
            }
        }));
        nearbyLines = Array.from(nearbyLinesMap.entries())
            .map(([line, minDist]) => ({ line, minDist }))
            .sort((a, b) => a.minDist - b.minDist);
        const nearbyNames = new Set(nearbyLines.map(l => l.line));
        otherLines = allLines.filter(l => !nearbyNames.has(l))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .map(line => ({ line, minDist: Infinity }));
    } else {
        otherLines = allLines
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .map(line => ({ line, minDist: Infinity }));
    }

    // ⭐ Section FAVORIS — affichée en premier si des favoris existent
    const favLines = [...favorites]
        .filter(l => knownLines.has(l))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (favLines.length > 0) {
        const favHeader = document.createElement('div');
        favHeader.className = 'filter-section-header fav-header';
        favHeader.innerHTML = '⭐ Mes lignes favorites';
        list.appendChild(favHeader);
        const favGrid = document.createElement('div');
        favGrid.className = 'filter-grid';
        favLines.forEach(line => favGrid.appendChild(makeLineBtn(line, null)));
        list.appendChild(favGrid);
    }

    // 📍 Lignes proches
    if (nearbyLines.length > 0) {
        const header = document.createElement('div');
        header.className = 'filter-section-header';
        header.innerHTML = '📍 Lignes actives proches';
        list.appendChild(header);
        const nearbyGrid = document.createElement('div');
        nearbyGrid.className = 'filter-grid';
        nearbyLines.forEach(({ line, minDist }) => {
            const dist = minDist < 100 ? `${Math.round(minDist)} m` : `${Math.round(minDist / 10) * 10} m`;
            nearbyGrid.appendChild(makeLineBtn(line, dist));
        });
        list.appendChild(nearbyGrid);
    }

    // 🚍 Autres lignes
    if (otherLines.length > 0) {
        const header = document.createElement('div');
        header.className = 'filter-section-header';
        header.innerHTML = nearbyLines.length > 0 ? '🚍 Autres lignes actives' : '🚍 Lignes actives en ce moment';
        list.appendChild(header);
        const otherGrid = document.createElement('div');
        otherGrid.className = 'filter-grid';
        otherLines.forEach(({ line }) => otherGrid.appendChild(makeLineBtn(line, null)));
        list.appendChild(otherGrid);
    }
}

document.getElementById('filter-btn').onclick = () => {
    buildFilterList();
    filterModal.classList.remove('hidden');
};

// Clic sur ⭐ dans la barre : Mode Toggle (Bascule)
document.getElementById('fav-btn').onclick = () => {
    const favBtn = document.getElementById('fav-btn');
    const activeFavs = [...favorites].filter(l => knownLines.has(l));
    
    if (activeFavs.length === 0) return; // Sécurité

    // Si le bouton est DÉJÀ actif, on désactive tout (on remet "Toutes")
    if (favBtn.classList.contains('active-fav')) {
        activeFilters.clear();
    } else {
        // Sinon, on applique les favoris
        activeFilters = new Set(activeFavs);
    }
    
    syncUI();
    updateBuses();
};

updateFavBtn(); // Initialise l'état du bouton au chargement

// [OPT #4] syncUI : filtrage visibilité sans recréation des marqueurs
// [OPT #4] syncUI : filtrage visibilité sans recréation des marqueurs
function syncUI() {
    const mainBtn = document.getElementById('filter-btn');
    mainBtn.innerHTML = activeFilters.size === 0
        ? '\ud83d\ude8d Filtrer'
        : `\ud83d\ude8d <span class="fav-count" style="background:var(--tcl-red);">${activeFilters.size}</span>`;

    document.querySelectorAll('.line-btn').forEach(b => {
        const line = b.dataset.line;
        if (!line) b.className = `line-btn ${activeFilters.size === 0 ? 'active' : ''}`;
        else        b.className = `line-btn ${activeFilters.has(line) ? 'active' : ''}`;
    });

    if (allStopMarkers.length > 0) filterStopsVisibility();
    if (allRoutesData.bus.length > 0) drawFilteredRoutes();
    updateFavBtn();

    // --- NOUVEAU : Met à jour l'état visuel du bouton Favoris (Allumé/Éteint) ---
    const favBtn = document.getElementById('fav-btn');
    if (favBtn) {
        const activeFavs = [...favorites].filter(l => knownLines.has(l));
        // On vérifie si les filtres actifs sont EXACTEMENT les mêmes que nos favoris dispo
        const isExactlyFavs = activeFilters.size > 0 && 
                              activeFilters.size === activeFavs.length && 
                              activeFavs.every(f => activeFilters.has(f));
        
        if (isExactlyFavs) {
            favBtn.classList.add('active-fav');
        } else {
            favBtn.classList.remove('active-fav');
        }
    }
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
        const res  = await fetch('/api/alerts');
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
            const debut        = formatAlertDate(a.debut);
            const fin          = formatAlertDate(a.fin);
            const ligneImpactee = a.ligne_cli || "Inconnue";
            const cleanMessage  = a.message ? a.message.replace(/<[^>]*>?/gm, '') : 'Détails indisponibles';

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
document.getElementById('close-alerts').onclick  = () => document.getElementById('alert-modal').classList.add('hidden');

map.on('zoomend', updateBuses);
setInterval(updateBuses, 15000);
updateBuses();
