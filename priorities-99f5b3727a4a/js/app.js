/**
 * Thetford Conservation Priorities - presentation view.
 *
 * Presents several tiered maps (ecological, agricultural), chosen with a switcher
 * at the top of the panel. Within a map it shows one thing at a time: that map's
 * combined tiered view, or a single contributing layer. Layers are coloured by the
 * tier they contribute to, so a layer and its tiered map always speak the same
 * visual language. Point values are deliberately not shown -- they determined the
 * tiers, but the tiers are the result worth presenting.
 *
 * Selection and description share one side panel: the description renders inline
 * beneath whichever row is selected, so the map keeps the rest of the screen.
 *
 * Clicking the map opens a popup with the source features behind each layer at
 * that point (a wetland's assessment, a crossing's species, a soil's rating),
 * read from the details-<layer>.geojson file published beside each layer.
 *
 * Reference overlays (parcels, conserved land...) can be drawn over any view from a
 * Layers button on the map. They are outlines only, so the tier fills stay legible,
 * and load live from the state's services, as on the main TCC map.
 */
const App = {
    map: null,
    layer: null,          // the Leaflet layer currently on the map
    data: null,           // data/layers.json: { maps: [...] }
    content: null,        // data/content.json: the descriptive text
    layersById: {},       // every layer of every map, by rule id
    layersBySlug: {},     // the same, by the readable name used in links (#significant-wetlands)
    cache: {},            // geojson by key, fetched once
    selected: null,       // a map id (its tiered view) or a layer id
    mapId: null,          // the map whose layers the panel is listing
    collapsed: {},        // "<map>:<tier>" -> true when that group is folded shut
    townLayer: null,      // town outline, drawn on every view

    TIER_ORDER: ['red', 'yellow', 'green'],

    // How near a click must come to a source feature to count, in metres, on top
    // of the layer's own buffer: lines and points can't otherwise be clicked.
    CLICK_TOLERANCE_M: 15,
    FEATURES_PER_SOURCE: 3,

    // Outline-only reference layers, loaded live from the state's services.
    // fields name what the click popup shows; nothing else is requested.
    OVERLAYS: [
        {
            id: 'conserved', name: 'Conserved land',
            url: 'https://services5.arcgis.com/Uzks6LSde6r23wwG/arcgis/rest/services/Conserved_Land_Inventory_Public_View/FeatureServer/0',
            style: { color: '#b5452b', weight: 2, opacity: 0.95, innerShade: 7 },
            fields: { 'Name': 'AREA_NAME', 'Owner': 'FEE_OWNER', 'Held by': 'INT_HOLDER', 'Protection': 'INT_TYPE' },
            townOnly: true,   // no town field: kept by whether it reaches inside the town line
            source: '<a href="https://geodata.vermont.gov/datasets/VTANR::conserved-land-inventory/about" target="_blank" rel="noopener">VT Conserved Lands Inventory</a>'
        },
        {
            id: 'parcels', name: 'Parcels',
            url: 'https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_VTPARCELS_WM_NOCACHE_v2/FeatureServer/1',
            where: "TOWN='THETFORD'",
            style: { color: '#4a4a4a', weight: 0.8, opacity: 0.8 },
            fields: { 'SPAN': 'GLIST_SPAN', 'Address': 'E911ADDR', 'Acres': 'ACRESGL' },
            source: '<a href="https://vcgi.vermont.gov/" target="_blank" rel="noopener">VCGI</a>'
        },
        {
            id: 'townlands', name: 'Town land',
            geojson: 'https://thetford-vt-conservation.github.io/maps/data/TownLands.geojson',
            style: { color: '#6a3d9a', weight: 2, opacity: 0.9, dashArray: '6 4', innerShade: 7 },
            fields: { 'SPAN': 'GLIST_SPAN', 'Address': 'E911ADDR' },
            source: '<a href="https://vcgi.vermont.gov/" target="_blank" rel="noopener">VCGI</a>'
        },
        {
            id: 'uva', name: 'Current use (UVA)',
            url: 'https://anrmaps.vermont.gov/arcgis/rest/services/Open_Data/OPENDATA_ANR_CADASTRAL_SP_NOCACHE_v2/MapServer/41',
            where: "SPAN LIKE '642-202-%'",   // Thetford's town code
            style: { color: '#c51b7d', weight: 1.5, opacity: 0.9, dashArray: '2 3', innerShade: 6 },
            fields: { 'SPAN': 'SPAN', 'Enrolled': 'ENTRYYEAR' },
            source: '<a href="https://fpr.vermont.gov/forest/UseValueAppraisal" target="_blank" rel="noopener">Use Value Appraisal</a>'
        },
        {
            id: 'zoning', name: 'Zoning districts',
            url: 'https://services1.arcgis.com/u6q3LNruiYmDjGX5/arcgis/rest/services/VTZONING_THETFORD_20110926_poly_zones/FeatureServer/0',
            where: "NOT (DISTRICT ='RURAL RESIDENTIAL')",
            style: { color: '#1f1f1f', weight: 1.5, opacity: 0.8, dashArray: '8 3 2 3', innerShade: 6 },
            fields: { 'District': 'DISTRICT' },
            idField: 'FID',
            source: '<a href="https://www.trorc.org/" target="_blank" rel="noopener">TRORC</a>'
        }
    ],
    overlayLayers: {},    // overlay id -> Leaflet layer, once switched on

    /**
     * A canvas renderer that shades a band just inside a polygon's outline (the
     * innerShade option, in pixels), as printed maps do for borders, so an outline
     * shows which side is inside. The polygon's own path is the clip: a wide, faint
     * stroke along it is cut off outside, leaving only its inner half.
     */
    ShadedCanvas: L.Canvas.extend({
        _fillStroke(ctx, layer) {
            const o = layer.options;
            if (o.innerShade && layer instanceof L.Polygon) {
                ctx.save();
                ctx.clip('evenodd');
                ctx.setLineDash([]);
                ctx.globalAlpha = 0.22;
                ctx.lineWidth = o.innerShade * 2;
                ctx.lineJoin = 'round';
                ctx.strokeStyle = o.color;
                ctx.stroke();
                ctx.restore();
            }
            L.Canvas.prototype._fillStroke.call(this, ctx, layer);
        }
    }),

    /**
     * Fetch a data file, revalidating rather than trusting the browser cache.
     * GitHub Pages lets browsers reuse files for ten minutes, so right after a
     * publish a viewer could get the new layers.json alongside stale geometry.
     * 'no-cache' still avoids re-downloading: an unchanged file comes back as a
     * 304 from its ETag.
     */
    async getJSON(path) {
        return (await fetch(path, { cache: 'no-cache' })).json();
    },

    async init() {
        this.map = L.map('map', { preferCanvas: true }).setView([43.835189, -72.252179], 12);
        L.esri.basemapLayer('Streets').addTo(this.map);

        // Its own pane above the data pane, so the outline stays visible whatever
        // gets added or removed underneath it.
        this.map.createPane('townPane').style.zIndex = 450;
        this.map.getPane('townPane').style.pointerEvents = 'none';
        // Overlays sit above the tiers and below the town outline. They never take
        // clicks: a click always reaches the tier beneath, and the popup reports the
        // overlay features at that point itself.
        this.map.createPane('overlayRefPane').style.zIndex = 440;
        this.map.getPane('overlayRefPane').style.pointerEvents = 'none';
        this.overlayRenderer = new this.ShadedCanvas({ pane: 'overlayRefPane' });
        await this.addTownBoundary();
        this.addOverlayControl();
        // A click on open ground (no tier there) still reports any overlays.
        this.map.on('click', e => {
            if (this._featureClicked) { this._featureClicked = false; return; }
            this.showDetails(e.latlng, this.mapById(this.mapId), [], null);
        });

        this.data = await this.getJSON('data/layers.json');

        // Prose is authored separately and overlaid here, so editing descriptions is
        // a text edit plus a refresh.
        try {
            this.content = await this.getJSON('data/content.json');
        } catch (e) {
            console.warn('content.json not found; using the default text', e);
            this.content = {};
        }
        for (const m of this.data.maps) {
            const c = this.content[`__map_${m.id}__`] || {};
            if (c.name) m.name = c.name;
            m.description = c.description || '';
            for (const l of m.layers) {
                l.mapId = m.id;
                const lc = this.content[l.id] || {};
                if (lc.name) l.name = lc.name;
                if (lc.goal !== undefined) l.goal = lc.goal;
                if (lc.motivation !== undefined) l.motivation = lc.motivation;
                // A hand-written method, for layers whose generated steps alone can't be
                // read without knowing how their source data was put together.
                if (lc.how_built) l.method = lc.how_built;
                // Links use a readable slug, fixed in content.json so renaming a layer
                // doesn't break links already shared; a layer without one gets it from its name.
                l.slug = lc.slug || this.slugify(l.name);
                this.layersById[l.id] = l;
                this.layersBySlug[l.slug] = l;
            }
        }

        // Deep-link the current view, so a particular map or layer can be opened
        // directly from a bookmark or a link in slides.
        await this.select(this.keyFromHash());
        window.addEventListener('hashchange', () => this.select(this.keyFromHash()));
    },

    /**
     * The view named in the URL: a map id or a layer slug. Older links named a layer
     * by its internal id (#custom_bb4680ce), and #__tiered__ meant the only map there
     * was; both still open the right view.
     */
    keyFromHash() {
        const h = decodeURIComponent(location.hash.slice(1));
        if (!h || h === '__tiered__') return this.data.maps[0].id;
        return (this.layersBySlug[h] || {}).id || h;
    },

    /** What the URL shows for a view: a map's id, or a layer's slug. */
    hashFor(key) { return this.mapById(key) ? key : (this.layersById[key] || {}).slug || key; },

    slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); },

    mapById(id) { return this.data.maps.find(m => m.id === id); },

    /** Town outline: always on, never selectable, never intercepts hover. */
    async addTownBoundary() {
        try {
            const geojson = await this.getJSON('data/town.geojson');
            this.townGeoJSON = geojson;
            this.townLayer = L.geoJSON(geojson, {
                pane: 'townPane',
                interactive: false,
                style: { color: '#3c4b57', weight: 2, opacity: 0.85, fill: false }
            }).addTo(this.map);
        } catch (e) {
            console.warn('town.geojson not found; continuing without the outline', e);
        }
    },

    /** Tiers this map actually defines, in display order. */
    tiersOf(m) { return this.TIER_ORDER.filter(t => m.tier_labels[t]); },

    renderLegend() {
        const m = this.mapById(this.mapId);
        document.getElementById('legend-title').textContent = m.legend_title || '';
        document.getElementById('legend-items').innerHTML = this.tiersOf(m).map(t => `
            <div class="key-row">
                <span class="swatch" style="background:${m.tier_colors[t]}"></span>
                <span>${m.tier_labels[t]}</span>
            </div>`).join('');
    },

    /** Rebuild the whole panel; the detail card is emitted inline after its row. */
    renderPanel() {
        const key = this.selected;
        const m = this.mapById(this.mapId);
        const out = [];

        out.push('<div class="switch" role="tablist">' + this.data.maps.map(x => `
            <button type="button" role="tab" data-map="${x.id}"
                    class="${x.id === m.id ? 'active' : ''}"
                    aria-selected="${x.id === m.id}">${x.short_name}</button>`).join('') + '</div>');

        const swatch = 'linear-gradient(135deg,' + this.tiersOf(m).map((t, i, a) =>
            `${m.tier_colors[t]} ${100 * i / a.length}% ${100 * (i + 1) / a.length}%`).join(',') + ')';
        out.push(`<div class="item combined ${key === m.id ? 'active' : ''}" data-key="${m.id}">
                      <span class="radio"></span><span class="swatch" style="background:${swatch}"></span>
                      <span class="label">${m.name}</span>
                  </div>`);
        if (key === m.id) out.push(this.detailHtml(m.id));

        out.push('<div class="caption">Contributing layers</div>');

        for (const tier of this.tiersOf(m)) {
            const layers = m.layers.filter(l => l.tier === tier);
            if (!layers.length) continue;

            const fold = `${m.id}:${tier}`;
            // Never leave the selected layer hidden inside a folded group.
            const collapsed = this.collapsed[fold] && !layers.some(l => l.id === key);

            out.push(`<div class="group ${collapsed ? 'collapsed' : ''}">
                <div class="group-head" data-toggle="${fold}">
                    <span class="chev"></span>
                    <span class="swatch" style="background:${m.tier_colors[tier]}"></span>
                    <span class="title">${m.tier_labels[tier]}</span>
                    <span class="count">${layers.length}</span>
                </div>
                <div class="group-body">`);

            for (const l of layers) {
                out.push(`<div class="item ${l.id === key ? 'active' : ''}" data-key="${l.id}">
                              <span class="radio"></span>
                              <span class="swatch" style="background:${l.color}"></span>
                              <span class="label">${l.name}</span>
                          </div>`);
                if (l.id === key) out.push(this.detailHtml(l.id));
            }
            out.push('</div></div>');
        }

        const panel = document.getElementById('panel');
        panel.innerHTML = out.join('');

        // Switching maps opens that map's tiered view.
        panel.querySelectorAll('.switch button').forEach(el =>
            el.addEventListener('click', () => this.select(el.dataset.map)));
        panel.querySelectorAll('.item').forEach(el =>
            el.addEventListener('click', () => this.select(el.dataset.key)));
        panel.querySelectorAll('.group-head').forEach(el =>
            el.addEventListener('click', () => {
                const f = el.dataset.toggle;
                this.collapsed[f] = !this.collapsed[f];
                this.renderPanel();
            }));
    },

    async load(key, file) {
        if (!this.cache[key]) this.cache[key] = await this.getJSON(file);
        return this.cache[key];
    },

    async select(key) {
        let m = this.mapById(key);
        if (!m) {
            const l = this.layersById[key];
            if (l) {
                m = this.mapById(l.mapId);
            } else {
                // Unknown or stale link: fall back to the first map.
                m = this.data.maps[0];
                key = m.id;
            }
        }
        // Keep the URL naming this view. An old-style or unknown link is rewritten in
        // place rather than added to history.
        const hash = this.hashFor(key);
        if (decodeURIComponent(location.hash.slice(1)) !== hash) {
            const replace = this.keyFromHash() === key || !this.layersById[this.keyFromHash()] && !this.mapById(this.keyFromHash());
            if (replace) history.replaceState(null, '', '#' + hash);
            else location.hash = hash;
        }
        if (this.selected === key) return;
        this.selected = key;

        if (m.id !== this.mapId) {
            this.mapId = m.id;
            this.renderLegend();
        }
        this.renderPanel();

        const isMap = key === m.id;
        const geojson = await this.load(key, isMap ? `data/${m.tiered_file}` : `data/${key}.geojson`);
        if (this.selected !== key) return;   // a newer click won while we fetched

        if (this.layer) this.map.removeLayer(this.layer);
        this.hideHover();
        this.map.closePopup();

        this.layer = isMap
            ? this.buildTieredLayer(geojson, m)
            : this.buildSingleLayer(geojson, this.layersById[key]);
        this.layer.addTo(this.map);
    },

    /** Darker shade of the fill, so borders don't read as a black mesh. */
    darken(hex, factor = 0.6) {
        const n = parseInt(hex.slice(1), 16);
        const r = Math.round(((n >> 16) & 255) * factor);
        const g = Math.round(((n >> 8) & 255) * factor);
        const b = Math.round((n & 255) * factor);
        return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
    },

    styleFor(color) {
        return { fillColor: color, color: this.darken(color), weight: 1, opacity: 0.7, fillOpacity: 0.7 };
    },

    buildTieredLayer(geojson, m) {
        const self = this;
        const lowest = m.tier_colors[this.tiersOf(m).slice(-1)[0]];
        let hovered = null;
        const layer = L.geoJSON(geojson, {
            renderer: L.canvas(),
            style: f => self.styleFor(m.tier_colors[f.properties.tier] || lowest)
        });
        layer.on('mouseover', e => {
            if (!e.layer || !e.layer.feature) return;
            hovered = e.layer;
            e.layer.setStyle({ weight: 3, fillOpacity: 0.85 });
            self.showHover(e.layer.feature.properties, m);
        });
        layer.on('mouseout', () => {
            if (hovered) { layer.resetStyle(hovered); hovered = null; }
            self.hideHover();
        });
        layer.on('click', e => {
            if (!e.layer || !e.layer.feature) return;
            self._featureClicked = true;
            const p = e.layer.feature.properties;
            let ids = p.contributing_rules || [];
            if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch (err) { ids = []; } }
            self.showDetails(e.latlng, m, ids, p.tier);
        });
        return layer;
    },

    buildSingleLayer(geojson, info) {
        const self = this;
        const layer = L.geoJSON(geojson, {
            renderer: L.canvas(),
            style: () => self.styleFor(info.color)
        });
        layer.on('mouseover', () => self.showHover({ single: info }));
        layer.on('mouseout', () => self.hideHover());
        layer.on('click', e => {
            self._featureClicked = true;
            self.showDetails(e.latlng, self.mapById(info.mapId), [info.id], null);
        });
        return layer;
    },

    /**
     * Popup listing, for each layer present at a point, the source features it was
     * drawn from there. The tier heads it in the tiered view; a single layer's view
     * already says which layer it is.
     */
    async showDetails(latlng, m, ids, tier) {
        const layers = m.layers.filter(l => ids.includes(l.id));
        const overlays = this.overlayHitsAt(latlng);
        if (!layers.length && !overlays.length) return;
        const popup = L.popup({ className: 'pt-popup', maxWidth: 320, maxHeight: 380, autoPanPadding: [24, 24] })
            .setLatLng(latlng)
            .setContent('<div class="pt"><p class="pt-note">Loading details&hellip;</p></div>')
            .openOn(this.map);

        const parts = await Promise.all(layers.map(async l => {
            let d;
            try {
                d = await this.load(`details:${l.id}`, `data/details-${l.id}.geojson`);
            } catch (e) {
                return this.layerDetailHtml(l, null, tier);
            }
            return this.layerDetailHtml(l, this.hitsAt(d, latlng), tier);
        }));
        if (!this.map.hasLayer(popup)) return;   // closed, or replaced by a newer click

        const head = tier && m.tier_labels[tier]
            ? `<div class="pt-tier"><span class="swatch" style="background:${m.tier_colors[tier]}"></span>${m.tier_labels[tier]}</div>`
            : '';
        const extra = overlays.length
            ? '<div class="pt-layer pt-overlays">' + overlays.map(o => {
                const rows = Object.entries(o.fields)
                    .map(([k, v]) => `<tr><th>${this.escape(k)}</th><td>${this.escape(v)}</td></tr>`).join('');
                return `<div class="pt-src">${this.escape(o.name)}</div>` + (rows ? `<table>${rows}</table>` : '');
            }).join('') + '</div>'
            : '';
        popup.setContent(`<div class="pt">${head}${parts.join('')}${extra}</div>`);
    },

    /** Features of the switched-on overlays that contain a point, already loaded on the map. */
    overlayHitsAt(latlng) {
        const kx = 111320 * Math.cos(latlng.lat * Math.PI / 180), ky = 110540;
        const toXY = c => [(c[0] - latlng.lng) * kx, (c[1] - latlng.lat) * ky];
        const out = [];
        for (const o of this.OVERLAYS) {
            const layer = this.overlayLayers[o.id];
            if (!layer || !this.map.hasLayer(layer)) continue;
            const feats = [];
            const visit = l => { if (l.feature) feats.push(l.feature); };
            layer.eachFeature ? layer.eachFeature(visit) : layer.eachLayer(visit);
            for (const f of feats) {
                if (!f.geometry || this.distanceTo(f.geometry, toXY) > 0) continue;
                const fields = {};
                for (const [label, key] of Object.entries(o.fields)) {
                    let v = (f.properties || {})[key];
                    if (v === null || v === undefined || String(v).trim() === '') continue;
                    if (typeof v === 'number' && !Number.isInteger(v)) v = Math.round(v * 10) / 10;
                    fields[label] = v;
                }
                out.push({ name: o.name, fields });
            }
        }
        return out;
    },

    /** The Layers button: a collapsed control on the map that switches overlays. */
    addOverlayControl() {
        const self = this;
        const Control = L.Control.extend({
            options: { position: 'topleft' },
            onAdd() {
                const box = L.DomUtil.create('div', 'overlay-control');
                box.innerHTML = `
                    <button type="button" class="overlay-toggle" aria-expanded="false" title="Reference overlays">
                        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 1.5 5 8 8.5 14.5 5 8 1.5Z M1.5 8 8 11.5 14.5 8 M1.5 11 8 14.5 14.5 11" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
                        <span>Layers</span>
                    </button>
                    <div class="overlay-list" hidden>
                        <div class="overlay-caption">Overlays</div>
                        ${self.OVERLAYS.map(o => `
                            <label class="overlay-row">
                                <input type="checkbox" data-overlay="${o.id}">
                                <svg class="overlay-swatch" width="22" height="12" aria-hidden="true">
                                    ${o.style.innerShade ? `<rect x="3" y="3" width="16" height="6" fill="none" stroke="${o.style.color}"
                                          stroke-opacity="0.22" stroke-width="4"/>` : ''}
                                    <rect x="1" y="1" width="20" height="10" fill="none" stroke="${o.style.color}"
                                          stroke-width="${Math.max(o.style.weight, 1.2)}" stroke-dasharray="${o.style.dashArray || ''}"/>
                                </svg>
                                <span>${o.name}</span>
                            </label>`).join('')}
                        <div class="overlay-note">Sources: ${[...new Set(self.OVERLAYS.map(o => o.source))].join(', ')}</div>
                    </div>`;
                L.DomEvent.disableClickPropagation(box);
                L.DomEvent.disableScrollPropagation(box);
                const btn = box.querySelector('.overlay-toggle');
                const list = box.querySelector('.overlay-list');
                btn.addEventListener('click', () => {
                    list.hidden = !list.hidden;
                    btn.setAttribute('aria-expanded', String(!list.hidden));
                });
                box.querySelectorAll('input[data-overlay]').forEach(cb =>
                    cb.addEventListener('change', () => self.setOverlay(cb.dataset.overlay, cb.checked)));
                return box;
            }
        });
        new Control().addTo(this.map);
    },

    async setOverlay(id, on) {
        const o = this.OVERLAYS.find(x => x.id === id);
        let layer = this.overlayLayers[id];
        if (!on) { if (layer) this.map.removeLayer(layer); return; }
        if (!layer) {
            const style = Object.assign({ fill: false, interactive: false }, o.style);
            if (o.geojson || o.townOnly) {
                const data = o.geojson ? await (await fetch(o.geojson)).json() : await this.fetchInTown(o);
                layer = L.geoJSON(data, { pane: 'overlayRefPane', renderer: this.overlayRenderer, interactive: false, style });
            } else {
                // Like the main map: fetched live, for the current view, simplified.
                layer = L.esri.featureLayer({
                    url: o.url, where: o.where || '1=1', fields: [o.idField || 'OBJECTID', ...Object.values(o.fields)],
                    pane: 'overlayRefPane', renderer: this.overlayRenderer, interactive: false,
                    simplifyFactor: 0.1, precision: 6, style: () => style
                });
                // The state's servers sometimes time out on a first request; try
                // again a few times before leaving the overlay part-drawn.
                let retries = 0;
                layer.on('requesterror', () => {
                    if (retries++ < 3) setTimeout(() => this.map.hasLayer(layer) && layer.refresh(), 3000);
                });
            }
            this.overlayLayers[id] = layer;
        }
        if (!this.map.hasLayer(layer)) layer.addTo(this.map);
    },

    layerDetailHtml(l, hits, tier) {
        const out = [`<div class="pt-layer"><div class="pt-name">${this.escape(l.name)}</div>`];
        if (!tier) out.push(`<div class="pt-standing">${l.tier_label}</div>`);
        if (!hits) {
            out.push('<p class="pt-note">Details could not be loaded.</p>');
        } else if (!hits.length) {
            out.push('<p class="pt-note">No source record at this exact spot.</p>');
        }
        for (const h of hits || []) {
            const rows = Object.entries(h.feature.properties).filter(([k]) => k !== '_s')
                .map(([k, v]) => `<tr><th>${this.escape(k)}</th><td>${this.escape(v)}</td></tr>`).join('');
            // Inside a buffer, say how far off the feature itself lies.
            const away = h.dist > this.CLICK_TOLERANCE_M
                ? `<span class="pt-away">${Math.round(h.dist * 3.28084).toLocaleString()} ft away</span>` : '';
            out.push(`<div class="pt-src">${this.escape(h.source.name)}${away}</div>` +
                     (rows ? `<table>${rows}</table>` : ''));
        }
        out.push('</div>');
        return out.join('');
    },

    /** Source features within reach of a point (their buffer plus a click's slack), nearest first per source. */
    hitsAt(d, latlng) {
        if (!d._prepared) {
            for (const f of d.features) f._bbox = this.bbox(f.geometry);
            d._prepared = true;
        }
        const lat0 = latlng.lat, lng0 = latlng.lng;
        const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
        const toXY = c => [(c[0] - lng0) * kx, (c[1] - lat0) * ky];
        const bySource = {};
        for (const f of d.features) {
            const src = d.sources[f.properties._s];
            const reach = src.buffer_m + this.CLICK_TOLERANCE_M;
            const b = f._bbox;
            // Cheap reject: the click is farther than reach from the bounding box.
            const dx = Math.max(b[0] - lng0, 0, lng0 - b[2]) * kx;
            const dy = Math.max(b[1] - lat0, 0, lat0 - b[3]) * ky;
            if (dx * dx + dy * dy > reach * reach) continue;
            const dist = this.distanceTo(f.geometry, toXY);
            if (dist > reach) continue;
            (bySource[f.properties._s] = bySource[f.properties._s] || []).push({ feature: f, source: src, dist });
        }
        return Object.keys(bySource).sort((a, b) => a - b).flatMap(k =>
            bySource[k].sort((a, b) => a.dist - b.dist).slice(0, this.FEATURES_PER_SOURCE));
    },

    bbox(g) {
        const b = [Infinity, Infinity, -Infinity, -Infinity];
        const walk = c => {
            if (typeof c[0] === 'number') {
                b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]);
                b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
            } else c.forEach(walk);
        };
        if (g.type === 'GeometryCollection') g.geometries.forEach(x => walk(x.coordinates));
        else walk(g.coordinates);
        return b;
    },

    /** Metres from the origin of toXY's local plane to a geometry; 0 inside a polygon. */
    distanceTo(g, toXY) {
        const segDist = (a, b) => {
            const vx = b[0] - a[0], vy = b[1] - a[1];
            const len = vx * vx + vy * vy;
            const t = len ? Math.max(0, Math.min(1, -(a[0] * vx + a[1] * vy) / len)) : 0;
            return Math.hypot(a[0] + t * vx, a[1] + t * vy);
        };
        const lineDist = line => {
            const pts = line.map(toXY);
            if (pts.length === 1) return Math.hypot(pts[0][0], pts[0][1]);
            let best = Infinity;
            for (let i = 1; i < pts.length; i++) best = Math.min(best, segDist(pts[i - 1], pts[i]));
            return best;
        };
        // Even-odd ray cast across every ring, so holes come out right.
        const polyDist = rings => {
            let inside = false, best = Infinity;
            for (const ring of rings) {
                const pts = ring.map(toXY);
                for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
                    const [xi, yi] = pts[i], [xj, yj] = pts[j];
                    if ((yi > 0) !== (yj > 0) && 0 < (xj - xi) * (0 - yi) / (yj - yi) + xi) inside = !inside;
                }
                best = Math.min(best, lineDist(ring));
            }
            return inside ? 0 : best;
        };
        const c = g.coordinates;
        switch (g.type) {
            case 'Point': return lineDist([c]);
            case 'MultiPoint': return Math.min(...c.map(p => lineDist([p])));
            case 'LineString': return lineDist(c);
            case 'MultiLineString': return Math.min(...c.map(lineDist));
            case 'Polygon': return polyDist(c);
            case 'MultiPolygon': return Math.min(...c.map(polyDist));
            case 'GeometryCollection': return Math.min(...g.geometries.map(x => this.distanceTo(x, toXY)));
            default: return Infinity;
        }
    },

    /**
     * Every feature of a service that reaches inside Thetford, fetched once. For a
     * layer with no town field: query the town's bounding box, then keep a feature
     * only if some vertex lies well inside the town line, so neighbours that just
     * share the boundary are dropped.
     */
    async fetchInTown(o) {
        const b = L.geoJSON(this.townGeoJSON).getBounds();
        const town = this.townGeoJSON.features[0].geometry;
        const features = [];
        for (let offset = 0; ; offset += 2000) {
            const q = new URLSearchParams({
                where: o.where || '1=1', outFields: [o.idField || 'OBJECTID', ...Object.values(o.fields)].join(','),
                geometry: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(','),
                geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects',
                outSR: 4326, geometryPrecision: 6, maxAllowableOffset: 0.00002,
                resultOffset: offset, resultRecordCount: 2000, f: 'geojson'
            });
            const page = await (await fetch(`${o.url}/query?${q}`)).json();
            features.push(...(page.features || []));
            if (!page.exceededTransferLimit && !(page.properties || {}).exceededTransferLimit) break;
        }
        const INSIDE_M = 20;
        const inside = ([lng, lat]) => {
            const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
            const toXY = c => [(c[0] - lng) * kx, (c[1] - lat) * ky];
            // distanceTo is 0 inside; a point well inside is far from every town edge too.
            if (this.distanceTo(town, toXY) > 0) return false;
            const rings = town.type === 'Polygon' ? town.coordinates : town.coordinates.flat();
            return this.distanceTo({ type: 'MultiLineString', coordinates: rings }, toXY) > INSIDE_M;
        };
        const vertices = g => g.type === 'Polygon' ? g.coordinates.flat()
            : g.type === 'MultiPolygon' ? g.coordinates.flat(2) : [];
        return { type: 'FeatureCollection',
                 features: features.filter(f => f.geometry && vertices(f.geometry).some(inside)) };
    },

    escape(v) {
        return String(v).replace(/[&<>"']/g, ch =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
    },

    showHover(props, m) {
        const box = document.getElementById('hover-box');
        if (props.single) {
            const i = props.single;
            box.innerHTML = `<div class="name">${i.name}</div><div class="standing">${i.tier_label}</div>`;
        } else {
            let names = props.contributing_rules || [];
            if (typeof names === 'string') { try { names = JSON.parse(names); } catch (e) { names = []; } }
            const items = names.map(id => `<li>${(this.layersById[id] || {}).name || id}</li>`).join('');
            const label = m.tier_labels[props.tier] || '';
            box.innerHTML = `<div class="name">${label}</div>` +
                (items ? `<div class="standing">Contributing here</div><ul>${items}</ul>` : '');
        }
        box.style.display = 'block';
    },

    hideHover() { document.getElementById('hover-box').style.display = 'none'; },

    detailHtml(key) {
        const m = this.mapById(key);
        if (m) {
            const n = m.layers.length;
            return `<div class="note">
                <div class="standing">All tiers</div>
                ${m.description ? `<p>${m.description}</p>` : ''}
                <p class="term">Built from ${n} contributing ${n === 1 ? 'layer' : 'layers'} &mdash; select one to see it alone.</p>
            </div>`;
        }

        const l = this.layersById[key];
        const b = [`<div class="note tier-${l.tier}">`];
        b.push(`<div class="standing">${l.tier_label}</div>`);

        // Extent as a sentence: this is a conservation document, not a dashboard.
        b.push(`<p>${l.acres.toLocaleString()} acres in town, across
                ${l.features.toLocaleString()} separate ${l.features === 1 ? 'area' : 'areas'}.</p>`);

        if (l.goal) b.push(`<p class="hdr">Goal</p><p>${l.goal}</p>`);
        if (l.motivation) b.push(`<p class="hdr">Why it matters</p><p>${l.motivation}</p>`);
        // One plain-language line per step, in order.
        const steps = Array.isArray(l.how_built) ? l.how_built : (l.how_built ? [l.how_built] : []);
        if (l.method || steps.length) {
            b.push('<p class="hdr">How it was defined</p>');
            if (l.method) b.push(`<p>${l.method}</p>`);
            // With a written method above it, the generated list is the exact rule:
            // kept visible so the layer stays reproducible, but set smaller.
            if (steps.length) b.push((l.method ? '<p class="term">Exact rule:</p>' : '') +
                `<ol class="built${l.method ? ' exact' : ''}">${steps.map(t => `<li>${t}</li>`).join('')}</ol>`);
        }
        if (l.sources && l.sources.length) {
            const s = l.sources.map(x => x.url
                ? `<a href="${x.url}" target="_blank" rel="noopener">${x.name}</a>` : x.name).join(', ');
            b.push(`<p class="term">Source: ${s}</p>`);
        }
        b.push('</div>');
        return b.join('');
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
