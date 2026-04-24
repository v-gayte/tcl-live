const map = L.map('map', { zoomControl: false }).setView([45.76, 4.83], 13);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap'
}).addTo(map);

const busLayer = L.layerGroup().addTo(map);
let userMarker = null;
let activeFilters = new Set();
let knownLines = new Set();

// --- GÉOLOCALISATION ---
document.getElementById('locate-btn').onclick = () => map.locate({ setView: true, maxZoom: 16 });

map.on('locationfound', (e) => {
    if (!userMarker) {
        userMarker = L.circleMarker(e.latlng, { radius: 8, fillColor: '#007bff', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(map);
    } else {
        userMarker.setLatLng(e.latlng);
    }
});

// --- GESTION DES BUS ---
function formatLine(val) {
    if(!val) return "?";
    return val.split('::')[1]?.split(':')[0] || val;
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

            // Icônes adaptatives au zoom
            const isZoomedOut = currentZoom < 14;
            const size = isZoomedOut ? 14 : 30;
            const text = isZoomedOut ? '' : line;

            const busIcon = L.divIcon({
                className: 'custom-bus-icon',
                html: `<span>${text}</span>`,
                iconSize: [size, size],
                iconAnchor: [size/2, size/2]
            });

            L.marker([lat, lng], { icon: busIcon }).addTo(busLayer)
             .bindPopup(`<b>Ligne ${line}</b><br>Direction: ${journey.DestinationRef?.value.split(':').pop()}`);
        });

        document.getElementById('update-text').innerText = `${new Date().toLocaleTimeString()} (${visibleCount} bus)`;
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
    btnAll.onclick = () => { activeFilters.clear(); syncUI(); updateBuses(); };
    list.appendChild(btnAll);

    Array.from(knownLines).sort((a,b) => a.localeCompare(b, undefined, {numeric: true})).forEach(line => {
        const btn = document.createElement('button');
        btn.className = `line-btn ${activeFilters.has(line) ? 'active' : ''}`;
        btn.innerText = line;
        btn.onclick = () => {
            if(activeFilters.has(line)) activeFilters.delete(line);
            else activeFilters.add(line);
            syncUI(); updateBuses();
        };
        list.appendChild(btn);
    });
    filterModal.classList.remove('hidden');
};

function syncUI() {
    const mainBtn = document.getElementById('filter-btn');
    if (activeFilters.size === 0) mainBtn.innerText = '🚍 Toutes';
    else mainBtn.innerText = `🚍 ${activeFilters.size} lignes`;
    
    document.querySelectorAll('.line-btn').forEach(b => {
        const l = b.innerText;
        if(l === "Toutes") b.className = `line-btn ${activeFilters.size === 0 ? 'active' : ''}`;
        else b.className = `line-btn ${activeFilters.has(l) ? 'active' : ''}`;
    });
}

// --- ALERTES ---
document.getElementById('alert-btn').onclick = async () => {
    const list = document.getElementById('alert-list');
    document.getElementById('alert-modal').classList.remove('hidden');
    list.innerHTML = "Chargement...";
    try {
        const res = await fetch('/api/alerts');
        const data = await res.json();
        list.innerHTML = "";
        (data.values || []).forEach(a => {
            const div = document.createElement('div');
            div.className = "alert-item";
            div.innerHTML = `<strong>${a.titre}</strong><p>${a.message.replace(/<[^>]*>?/gm, '')}</p>`;
            list.appendChild(div);
        });
    } catch (e) { list.innerHTML = "Erreur de chargement."; }
};

// Fermetures
document.getElementById('close-filters').onclick = () => filterModal.classList.add('hidden');
document.getElementById('close-alerts').onclick = () => document.getElementById('alert-modal').classList.add('hidden');

map.on('zoomend', updateBuses);
setInterval(updateBuses, 15000);
updateBuses();