/**
 * TCL Live - Application de suivi en temps réel du réseau TCL
 */

// --- INITIALISATION CARTE ---
const map = L.map('map', { zoomControl: false }).setView([45.76, 4.83], 13);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap' }).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const busLayer    = L.layerGroup().addTo(map);
const routesLayer = L.layerGroup().addTo(map);

// --- VARIABLES GLOBALES ---
let userMarker   = null;
let userPosition = null;
let activeFilters   = new Set();
let knownLines      = new Set();
let busPositionsByLine = {};

// Données statiques
let dictStops   = {};
let allStopsGeo = [];
const stopsLayer = L.layerGroup();
let currentStopInterval = null;
let allRoutesData = { bus: [], tram: [], metro: [] };

// [OPT] Tableau des marqueurs d'arrêts créés une seule fois pour éviter le lag
let allStopMarkers = [];

// Favoris (persistés en localStorage)
let favorites = new Set(JSON.parse(localStorage.getItem('tcl_favorites') || '[]').filter(l => l && !l.startsWith('JD')));

// --- GESTION DES FAVORIS ---

/**
 * Sauvegarde les favoris dans le localStorage.
 */
function saveFavorites() {
    localStorage.setItem('tcl_favorites', JSON.stringify([...favorites]));
}

/**
 * Alterne l'état favori d'une ligne.
 */
function toggleFavorite(line) {
    if (favorites.has(line)) favorites.delete(line);
    else favorites.add(line);
    saveFavorites();
}

/**
 * Met à jour l'affichage du bouton favoris dans la barre d'état.
 */
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

// Chargement initial des arrêts (donnée critique)
fetch('/api/stops')
    .then(res => res.json())
    .then(data => {
        dictStops   = data.dict || data;
        allStopsGeo = data.geo  || [];
        buildStopsLayer();
    }).catch(e => console.error("⚠️ Erreur chargement arrêts:", e));

/**
 * Charge les tracés WFS en différé.
 * [OPT] Utilise requestIdleCallback pour ne pas bloquer le rendu initial.
 */
function loadRoutes() {
    fetch('/api/routes')
        .then(res => res.json())
        .then(data => {
            allRoutesData = data;
            Object.values(allRoutesData).forEach(features => {
                features.forEach(f => {
                    const name = f.properties.ligne || f.properties.code_ligne || f.properties.nom;
                    if (name && name !== '?' && !name.startsWith('JD')) {
                        knownLines.add(name);
                    }
                });
            });
            drawFilteredRoutes();
        }).catch(e => console.error("⚠️ Erreur tracés:", e));
}

if ('requestIdleCallback' in window) {
    requestIdleCallback(loadRoutes, { timeout: 3000 });
} else {
    setTimeout(loadRoutes, 500); // Fallback pour navigateurs non compatibles
}

// --- TRACÉS WFS (GÉOMÉTRIE) ---

/**
 * Dessine les tracés des lignes sur la carte en fonction des filtres actifs.
 */
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

    draw(allRoutesData.bus,   '#888888', 2, 0.3);
    draw(allRoutesData.tram,  '#E2001A', 3, 0.5);

    // Tracés Métro avec couleurs spécifiques
    const metroColors = { 'A': '#f12c32', 'B': '#0168b3', 'C': '#f7941d', 'D': '#00a84f', 'F1': '#84552e', 'F2': '#84552e' };
    allRoutesData.metro.forEach(feature => {
        const line = feature.properties.ligne || feature.properties.code_ligne || feature.properties.nom;
        if (activeFilters.size > 0 && !activeFilters.has(line)) return;
        L.geoJSON(feature, {
            style: { color: metroColors[line] || '#333', weight: 5, opacity: 0.8 },
            interactive: false
        }).addTo(routesLayer);
    });
}

// --- UTILITAIRES ---

/**
 * Calcule la distance en mètres entre deux points géographiques.
 */
function distanceMeters(lat1, lng1, lat2, lng2) {
    const R    = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
               + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
               * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- GESTION DES ARRÊTS ---

/**
 * Construit la couche des marqueurs d'arrêts.
 * [OPT] Les marqueurs sont créés une seule fois.
 */
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

        const metroLinesAtStop = stop.lines.filter(l => ['A', 'B', 'C', 'D', 'F1', 'F2'].includes(l));
        const mMetro = metroLinesAtStop.length > 0;
        
        const metroColors = { 'A': '#f12c32', 'B': '#0168b3', 'C': '#f7941d', 'D': '#00a84f', 'F1': '#84552e', 'F2': '#84552e' };
        const bgColor = mMetro ? (metroColors[metroLinesAtStop[0]] || '#333') : '#555';

        const m = mMetro ? L.marker([stop.lat, stop.lng], {
            icon: L.divIcon({
                className: 'metro-stop-icon',
                html: `<div class="metro-stop-inner" style="background:${bgColor}; font-size:${metroLinesAtStop.join('').length > 2 ? '10px' : '13px'};">${metroLinesAtStop.join('/')}</div>`,
                iconSize: [34, 26],
                iconAnchor: [17, 13],
                popupAnchor: [0, -13]
            })
        }) : L.circleMarker([stop.lat, stop.lng], {
            radius: 7, fillColor: '#555', color: '#fff',
            weight: 2, fillOpacity: 0.6, opacity: 0.9,
        });

        m.bindPopup(`
            <div style="min-width:200px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <b>${stop.nom}</b>
                </div>
                <div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:2px;">
                    ${linesHtml}
                </div>
                <hr style="border:0;border-top:1px solid #eee;margin:8px 0;">
                <div id="${popupId}">⏳ Chargement...</div>
            </div>`);

        m.on('popupopen', () => {
            const el  = document.getElementById(popupId);

            const fetchArrivals = async () => {
                if (!el) return;
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
            };

            fetchArrivals();

            if (currentStopInterval) clearInterval(currentStopInterval);
            currentStopInterval = setInterval(fetchArrivals, 10000); // 10s
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

/**
 * Filtre la visibilité des arrêts en fonction des lignes actives.
 */
function filterStopsVisibility() {
    stopsLayer.clearLayers();
    allStopMarkers.forEach(({ marker, stop }) => {
        if (activeFilters.size === 0 || stop.lines.some(l => activeFilters.has(l))) {
            stopsLayer.addLayer(marker);
        }
    });
}

/**
 * Affiche ou cache la couche des arrêts selon le niveau de zoom.
 */
function toggleStopsVisibility() {
    if (map.getZoom() >= 15) { if (!map.hasLayer(stopsLayer)) map.addLayer(stopsLayer); }
    else { if (map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer); }
}
map.on('zoomend', toggleStopsVisibility);

// --- GÉOLOCALISATION ---
let isTrackingLocation = false;
let firstLocationFound = false;
let shouldAlertOnError = false;

document.getElementById('locate-btn').onclick = () => {
    shouldAlertOnError = true;

    if (!navigator.geolocation) {
        alert("La géolocalisation n'est pas supportée par votre navigateur.");
        return;
    }

    if (!isTrackingLocation) {
        isTrackingLocation = true;
        document.getElementById('locate-btn').style.color = 'var(--tcl-red)';
        
        // [NOTE] Sur Chrome/Safari, la géolocalisation nécessite HTTPS (sauf localhost)
        map.locate({ watch: true, setView: false, enableHighAccuracy: true });

        if (userPosition) map.setView([userPosition.lat, userPosition.lng], 16);
    } else {
        if (userPosition) {
            map.setView([userPosition.lat, userPosition.lng], 16);
        }
    }
};

map.on('locationfound', (e) => {
    shouldAlertOnError = false;
    userPosition = { lat: e.latlng.lat, lng: e.latlng.lng };

    if (!userMarker) {
        userMarker = L.circleMarker(e.latlng, {
            radius: 10, fillColor: '#007bff', color: '#fff', weight: 3, fillOpacity: 1
        }).addTo(map);
    } else {
        userMarker.setLatLng(e.latlng);
    }

    if (!firstLocationFound && isTrackingLocation) {
        map.setView(e.latlng, 16);
        firstLocationFound = true;
    }
});

map.on('locationerror', (e) => {
    console.warn("Erreur de géolocalisation:", e.message);
    
    if (shouldAlertOnError) {
        let msg = "Impossible d'accéder à votre position.";
        
        if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
            msg += "\n\n⚠️ Erreur de sécurité : La géolocalisation nécessite une connexion sécurisée (HTTPS).";
        } else {
            msg += "\n\nVérifiez que vous avez autorisé l'accès à la position dans les réglages de votre navigateur.";
        }
        
        alert(msg);
    }
    
    map.stopLocate();
    isTrackingLocation = false;
    shouldAlertOnError = false;
    document.getElementById('locate-btn').style.color = '';
});

// --- GESTION DES BUS ---

/**
 * Formate le nom de la ligne à partir de la référence SIRI.
 */
function formatLine(val) {
    if (!val) return "?";
    const parts = val.split(':');
    // Trouver la première partie non vide après le préfixe TCL
    const res = parts.slice(1).find(p => p && p !== 'Line') || parts[0];
    return res === '?' ? '?' : res;
}

/**
 * Récupère le nom d'un arrêt à partir de son ID ou de l'objet SIRI.
 */
function getStopName(siriRef, siriNameObj) {
    if (siriNameObj && siriNameObj[0] && siriNameObj[0].value) return siriNameObj[0].value;
    if (!siriRef) return "Inconnue";
    const stopId = siriRef.split(':')[3];
    return dictStops[stopId] || `Arrêt n°${stopId}`;
}

/**
 * Met à jour les positions des bus sur la carte.
 */
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
            if (line && line !== '?' && !line.startsWith('JD')) {
                knownLines.add(line);
            }
            
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

// --- MODAL FILTRES ---

const filterModal = document.getElementById('filter-modal');

/**
 * Crée un bouton de ligne avec étoile favori intégrée.
 */
function makeLineBtn(line, distLabel) {
    const btn = document.createElement('button');
    btn.className    = `line-btn ${activeFilters.has(line) ? 'active' : ''}`;
    btn.dataset.line = line;

    // Étoile favori
    const star = document.createElement('span');
    star.className = `fav-star${favorites.has(line) ? ' starred' : ''}`;
    star.textContent = favorites.has(line) ? '★' : '☆';
    star.addEventListener('click', (e) => {
        e.stopPropagation(); // Évite de déclencher le filtre lors du clic sur l'étoile
        toggleFavorite(line);
        star.className   = `fav-star${favorites.has(line) ? ' starred' : ''}`;
        star.textContent = favorites.has(line) ? '★' : '☆';
        updateFavBtn();
        buildFilterList(); // Reconstruit pour mettre à jour la section favoris
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

/**
 * Construit le contenu du modal filtre (Favoris, Proches, Métro, Tram, Bus).
 */
function buildFilterList() {
    const list = document.getElementById('filter-list');
    list.innerHTML = '';

    // Bouton "Toutes" les lignes
    const btnAll = document.createElement('button');
    btnAll.className = `line-btn ${activeFilters.size === 0 ? 'active' : ''}`;
    btnAll.innerText = 'Toutes';
    btnAll.onclick   = () => { activeFilters.clear(); syncUI(); updateBuses(); };
    list.appendChild(btnAll);

    const allLines = Array.from(knownLines);
    
    // Categorisation
    const metroLines = ['A', 'B', 'C', 'D', 'F1', 'F2'];
    const tramLines  = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'RX'];
    
    const categories = [
        { id: 'fav',    title: '⭐ Mes lignes favorites', lines: [...favorites].filter(l => knownLines.has(l)) },
        { id: 'metro',  title: '🚇 Métro & Funiculaire', lines: allLines.filter(l => metroLines.includes(l)) },
        { id: 'tram',   title: '🚋 Tramway',              lines: allLines.filter(l => tramLines.includes(l)) },
        { id: 'bus',    title: '🚍 Bus',                  lines: allLines.filter(l => !metroLines.includes(l) && !tramLines.includes(l)) }
    ];

    // Calcul des lignes à proximité (500m)
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
        const nearbyLinesData = Array.from(nearbyLinesMap.entries())
            .map(([line, minDist]) => ({ line, minDist }))
            .sort((a, b) => a.minDist - b.minDist);

        if (nearbyLinesData.length > 0) {
            const header = document.createElement('div');
            header.className = 'filter-section-header';
            header.innerHTML = '📍 Lignes actives proches';
            list.appendChild(header);
            const nearbyGrid = document.createElement('div');
            nearbyGrid.className = 'filter-grid';
            nearbyLinesData.forEach(({ line, minDist }) => {
                const dist = minDist < 100 ? `${Math.round(minDist)} m` : `${Math.round(minDist / 10) * 10} m`;
                nearbyGrid.appendChild(makeLineBtn(line, dist));
            });
            list.appendChild(nearbyGrid);
        }
    }

    // Affichage par catégories
    categories.forEach(cat => {
        if (cat.lines.length === 0) return;

        const headerWrapper = document.createElement('div');
        headerWrapper.className = 'filter-section-header category-header';
        
        const titleSpan = document.createElement('span');
        titleSpan.innerHTML = cat.title;
        headerWrapper.appendChild(titleSpan);

        // Bouton de basculement de catégorie (sauf pour favoris peut-être, mais pourquoi pas)
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'category-toggle';
        
        const allInCatSelected = cat.lines.every(l => activeFilters.has(l));
        toggleBtn.innerText = allInCatSelected ? 'Tout désélectionner' : 'Tout sélectionner';
        
        toggleBtn.onclick = () => {
            const shouldSelect = !allInCatSelected;
            cat.lines.forEach(l => {
                if (shouldSelect) activeFilters.add(l);
                else activeFilters.delete(l);
            });
            syncUI();
            updateBuses();
            buildFilterList(); // Rafraîchir pour mettre à jour le texte du bouton toggle
        };
        
        headerWrapper.appendChild(toggleBtn);
        list.appendChild(headerWrapper);

        const grid = document.createElement('div');
        grid.className = 'filter-grid';
        cat.lines.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                 .forEach(line => grid.appendChild(makeLineBtn(line, null)));
        list.appendChild(grid);
    });
}

document.getElementById('filter-btn').onclick = () => {
    buildFilterList();
    filterModal.classList.remove('hidden');
};

// Clic sur bouton Favoris (Barre d'état)
document.getElementById('fav-btn').onclick = () => {
    const favBtn = document.getElementById('fav-btn');
    const activeFavs = [...favorites].filter(l => knownLines.has(l));
    
    if (activeFavs.length === 0) return;

    // Si déjà actif, on désactive
    if (favBtn.classList.contains('active-fav')) {
        activeFilters.clear();
    } else {
        // Sinon, on applique les favoris comme filtres
        activeFilters = new Set(activeFavs);
    }
    
    syncUI();
    updateBuses();
};

/**
 * Synchronise l'interface utilisateur avec l'état des filtres.
 * [OPT] Filtrage de visibilité sans recréation des marqueurs.
 */
function syncUI() {
    const mainBtn = document.getElementById('filter-btn');
    mainBtn.innerHTML = activeFilters.size === 0
        ? '🚍 Filtrer'
        : `🚍 <span class="fav-count" style="background:var(--tcl-red);">${activeFilters.size}</span>`;

    document.querySelectorAll('.line-btn').forEach(b => {
        const line = b.dataset.line;
        if (!line) b.className = `line-btn ${activeFilters.size === 0 ? 'active' : ''}`;
        else        b.className = `line-btn ${activeFilters.has(line) ? 'active' : ''}`;
    });

    if (allStopMarkers.length > 0) filterStopsVisibility();
    if (allRoutesData.bus.length > 0) drawFilteredRoutes();
    updateFavBtn();

    // Met à jour l'état visuel du bouton Favoris
    const favBtn = document.getElementById('fav-btn');
    if (favBtn) {
        const activeFavs = [...favorites].filter(l => knownLines.has(l));
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

// --- GESTION DES ALERTES ---

/**
 * Formate la date d'une alerte.
 */
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

// --- INITIALISATION & BOUCLES ---

document.getElementById('close-filters').onclick = () => filterModal.classList.add('hidden');
document.getElementById('close-alerts').onclick  = () => document.getElementById('alert-modal').classList.add('hidden');

// Fermer les modals en cliquant à l'extérieur
window.onclick = (event) => {
    if (event.target.classList.contains('modal')) {
        event.target.classList.add('hidden');
    }
};

map.on('zoomend', updateBuses);
setInterval(updateBuses, 5000); // Rafraîchissement automatique des bus (5s)
updateBuses();
updateFavBtn();
