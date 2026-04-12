// ============================================================
// SkyAlert PWA — App Logic (Produktiv mit AviationStack API)
// Keine Anmeldung · DSGVO-konform · Echtzeit-Daten
// ============================================================

// ===== REFRESH CONFIG =====
const REFRESH_INTERVALS = {
  flightStatus: 180,   // 3 Minuten (schont API-Kontingent)
  watchlist: 120,       // 2 Minuten
  disruptions: 300,     // 5 Minuten
  airlines: 600         // 10 Minuten
};

// ===== STATE =====
let lastRefreshTime = Date.now();
let refreshCountdown = REFRESH_INTERVALS.flightStatus;
let refreshTimerId = null;
let isOnline = navigator.onLine;
let dsgvoConsent = null;

let currentFlights = [];       // Currently displayed flights
let watchlistFlights = [];     // Watchlist flights (transformed)
let airlineStats = [];         // Computed airline stats
let alerts = [];               // Alert notifications
let newsArticles = [];         // News articles
let currentNewsFilter = 'all'; // Current news filter
let newsLoaded = false;        // Whether news has been loaded once
let isLoading = false;

// Watchlist: stored in localStorage as array of flight IATA codes
const WATCHLIST_KEY = 'skyalert_watchlist';
const ALERTS_KEY = 'skyalert_alerts';
const RECENT_KEY = 'skyalert_recent';

// ===== DOM HELPERS =====
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  initDSGVO();
  initTabNav();
  initSearch();
  initSettings();
  initApiKeySettings();
  initManualRefresh();
  initQuickActions();
  initModalHandlers();
  initOnlineStatus();
  initPWA();

  loadWatchlist();
  loadAlerts();

  // Initial data load
  loadInitialData();
  initNewsFilters();
  loadNews(); // Load news in parallel

  // Only auto-refresh if user explicitly enabled it
  const autoRefreshSaved = localStorage.getItem('skyalert_auto_refresh');
  if (autoRefreshSaved === 'true') {
    $('#settingAutoRefresh').checked = true;
    startRefreshCycle();
  } else {
    updateFreshnessBarManual();
  }

  drawWorldMap();
  updateQuotaDisplay();
});

// ===== DSGVO =====
function initDSGVO() {
  dsgvoConsent = localStorage.getItem('skyalert_dsgvo');
  if (dsgvoConsent) {
    $('#dsgvoOverlay').classList.add('hidden');
  }

  $('#dsgvoAccept').addEventListener('click', () => {
    localStorage.setItem('skyalert_dsgvo', 'full');
    localStorage.setItem('skyalert_dsgvo_date', new Date().toISOString());
    dsgvoConsent = 'full';
    $('#dsgvoOverlay').classList.add('hidden');
  });

  $('#dsgvoMinimal').addEventListener('click', () => {
    localStorage.setItem('skyalert_dsgvo', 'minimal');
    localStorage.setItem('skyalert_dsgvo_date', new Date().toISOString());
    dsgvoConsent = 'minimal';
    localStorage.removeItem(RECENT_KEY);
    $('#settingSearchHistory').checked = false;
    $('#dsgvoOverlay').classList.add('hidden');
  });
}

// ===== INITIAL DATA LOAD =====
async function loadInitialData() {
  showLoadingState('Flugdaten werden geladen...');

  try {
    // Load ALL flights globally (not just TLV)
    const result = await AviationAPI.getAllFlights();
    currentFlights = (result.data || []).map(AviationAPI.transformFlight);

    // Also try to get some cancelled flights for the disruption view
    try {
      const cancelled = await AviationAPI.getCancelledFlights();
      const cancelledTransformed = (cancelled.data || []).map(AviationAPI.transformFlight);

      // Merge cancelled into currentFlights if not already present
      cancelledTransformed.forEach(cf => {
        if (!currentFlights.find(f => f.numberRaw === cf.numberRaw)) {
          currentFlights.push(cf);
        }
      });
    } catch (e) {
      console.warn('[SkyAlert] Could not load cancelled flights:', e);
    }

    // Compute airline stats from loaded flights
    airlineStats = AviationAPI.computeAirlineStats(currentFlights);

    // Generate alerts from flight data
    generateAlertsFromFlights(currentFlights);

    renderAll();
    updateRefreshIndicator('live');
    lastRefreshTime = Date.now();

  } catch (err) {
    console.error('[SkyAlert] Initial load failed:', err);
    if (err.message === 'OFFLINE') {
      updateRefreshIndicator('offline');
      showError('Sie sind offline. Bitte stellen Sie eine Internetverbindung her.');
    } else {
      showError(`Fehler beim Laden: ${err.message}`);
    }
  }

  hideLoadingState();
  updateQuotaDisplay();
}

// ===== LOAD WATCHLIST =====
function loadWatchlist() {
  try {
    const stored = localStorage.getItem(WATCHLIST_KEY);
    watchlistFlights = stored ? JSON.parse(stored) : [];
  } catch {
    watchlistFlights = [];
  }
}

function saveWatchlist() {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlistFlights));
  updateWatchlistBadge();
}

function updateWatchlistBadge() {
  const badge = $('#watchlistBadge');
  if (watchlistFlights.length > 0) {
    badge.textContent = String(watchlistFlights.length);
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

// ===== LOAD ALERTS =====
function loadAlerts() {
  try {
    const stored = localStorage.getItem(ALERTS_KEY);
    alerts = stored ? JSON.parse(stored) : [];
  } catch {
    alerts = [];
  }
}

function saveAlerts() {
  localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts));
  updateAlertsBadge();
}

function updateAlertsBadge() {
  const badge = $('#alertsBadge');
  const unread = alerts.filter(a => a.unread).length;
  if (unread > 0) {
    badge.textContent = String(unread);
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function generateAlertsFromFlights(flights) {
  const now = Date.now();
  const existingIds = new Set(alerts.map(a => a.id));

  flights.forEach(f => {
    if (f.status === 'cancelled') {
      const id = `cancel_${f.numberRaw}_${f.flightDate}`;
      if (!existingIds.has(id)) {
        alerts.unshift({
          id,
          type: 'cancellation',
          typeText: '🔴 Stornierung',
          time: new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
          body: `<span class="alert-flight">${f.number}</span> ${f.fromCity || f.from} → ${f.toCity || f.to} wurde storniert.`,
          unread: true,
          timestamp: now
        });
      }
    } else if (f.delay > 60) {
      const id = `majordelay_${f.numberRaw}_${f.flightDate}`;
      if (!existingIds.has(id)) {
        alerts.unshift({
          id,
          type: 'status-change',
          typeText: '🟡 Erhebliche Verspätung',
          time: new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
          body: `<span class="alert-flight">${f.number}</span> hat +${f.delay} Minuten Verspätung.`,
          unread: true,
          timestamp: now
        });
      }
    } else if (f.flightStatus === 'diverted') {
      const id = `diverted_${f.numberRaw}_${f.flightDate}`;
      if (!existingIds.has(id)) {
        alerts.unshift({
          id,
          type: 'region-alert',
          typeText: '🟠 Umleitung',
          time: new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
          body: `<span class="alert-flight">${f.number}</span> wurde umgeleitet.`,
          unread: true,
          timestamp: now
        });
      }
    }
  });

  // Keep only last 50 alerts
  alerts = alerts.slice(0, 50);
  saveAlerts();
}

// ===== TAB NAVIGATION =====
function switchTab(pageId) {
  $$('.tab-item').forEach(t => t.classList.remove('active'));
  const targetTab = Array.from($$('.tab-item')).find(t => t.dataset.page === pageId);
  if (targetTab) targetTab.classList.add('active');

  $$('.page').forEach(p => {
    p.classList.remove('active');
    if (p.id === pageId) p.classList.add('active');
  });

  if (pageId === 'pageMap') setTimeout(drawWorldMap, 50);
  if (pageId === 'pageWatchlist') refreshWatchlist();
  if (pageId === 'pageNews' && !newsLoaded) loadNews();
}

function initTabNav() {
  $$('.tab-item').forEach(tab => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.page);
    });
  });
}

// ===== QUICK ACTIONS =====
function initQuickActions() {
  $$('.quick-action-card').forEach(card => {
    card.addEventListener('click', () => {
      const action = card.dataset.action;
      if (action === 'nearby') {
        switchTab('pageMap');
      } else if (action === 'disruptions') {
        switchTab('pageAlerts');
      }
    });
  });

  const banner = $('#disruptionBanner');
  if (banner) {
    banner.addEventListener('click', () => {
      switchTab('pageAlerts');
    });
  }
}

// ===== SEARCH =====
function initSearch() {
  const input = $('#searchInput');
  const clear = $('#searchClear');
  let searchTimeout = null;

  input.addEventListener('input', () => {
    clear.style.display = input.value ? 'block' : 'none';

    clearTimeout(searchTimeout);
    if (input.value.trim().length >= 2) {
      searchTimeout = setTimeout(() => performSearch(input.value.trim()), 600);
    } else if (input.value.trim().length === 0) {
      renderTrending();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchTimeout);
      if (input.value.trim().length >= 2) {
        performSearch(input.value.trim());
      }
    }
  });

  clear.addEventListener('click', () => {
    input.value = '';
    clear.style.display = 'none';
    renderTrending();
  });

  // Route Search
  $('#routeSearchBtn').addEventListener('click', () => {
    const from = $('#routeFrom').value.trim().toUpperCase();
    const to = $('#routeTo').value.trim().toUpperCase();
    if (from || to) {
      performRouteSearch(from, to);
    }
  });

  // Enter key for route search
  $('#routeFrom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#routeSearchBtn').click();
  });
  $('#routeTo').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#routeSearchBtn').click();
  });
}

async function performRouteSearch(fromIata, toIata) {
  showTrendingLoading();

  try {
    const result = await AviationAPI.getFlightsByRoute(fromIata, toIata);
    const flights = (result.data || []).map(AviationAPI.transformFlight);

    if (flights.length === 0) {
      $('#trendingList').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <div class="empty-text">Keine Flüge gefunden</div>
          <div class="empty-sub">Für die Strecke ${fromIata || 'Alle'} → ${toIata || 'Alle'} konnten wir derzeit keine echten Live-Flüge abrufen.</div>
        </div>
      `;
      $('#trendingCount').textContent = '0 Ergebnisse';
    } else {
      $('#trendingList').innerHTML = flights.map(f => createFlightCard(f)).join('');
      $('#trendingCount').textContent = `${flights.length} Ergebnisse`;
    }

    saveRecentSearch(`${fromIata || '*'} - ${toIata || '*'}`);
    updateQuotaDisplay();
  } catch (err) {
    $('#trendingList').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <div class="empty-text">Fehler bei der Suche</div>
        <div class="empty-sub">${err.message}</div>
      </div>
    `;
    $('#trendingCount').textContent = 'Fehler';
  }
}

async function performSearch(query) {
  showTrendingLoading();

  try {
    const result = await AviationAPI.search(query);
    const flights = (result.data || []).map(AviationAPI.transformFlight);

    if (flights.length === 0) {
      $('#trendingList').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <div class="empty-text">Keine Flüge gefunden für „${query}"</div>
          <div class="empty-sub">Versuche eine Flugnummer (z.B. LH690) oder einen Flughafen-Code (z.B. FRA)</div>
        </div>
      `;
    } else {
      $('#trendingList').innerHTML = flights.map(f => createFlightCard(f)).join('');
      $('#trendingCount').textContent = `${flights.length} Ergebnisse`;
    }

    // Save to recent searches
    saveRecentSearch(query);
    updateQuotaDisplay();

  } catch (err) {
    $('#trendingList').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <div class="empty-text">Fehler bei der Suche</div>
        <div class="empty-sub">${err.message}</div>
      </div>
    `;
  }
}

function saveRecentSearch(query) {
  if (dsgvoConsent === 'minimal') return;
  try {
    let recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    recent = recent.filter(r => r.query !== query);
    recent.unshift({ query, time: Date.now() });
    recent = recent.slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    renderRecentSearches();
  } catch {}
}

// ===== WATCHLIST REFRESH =====
async function refreshWatchlist() {
  if (watchlistFlights.length === 0) {
    renderWatchlist();
    return;
  }

  // Refresh each watchlisted flight
  for (const wf of watchlistFlights) {
    try {
      const result = await AviationAPI.getFlightByIata(wf.numberRaw);
      if (result.data && result.data.length > 0) {
        const updated = AviationAPI.transformFlight(result.data[0]);
        // Merge updated data
        Object.assign(wf, updated);
        wf.lastUpdate = Date.now();
      }
    } catch (e) {
      console.warn(`[SkyAlert] Watchlist refresh failed for ${wf.numberRaw}:`, e);
    }
  }

  saveWatchlist();
  renderWatchlist();
  updateQuotaDisplay();
}

// ===== SETTINGS =====
function initSettings() {
  $('#settingsBtn').addEventListener('click', () => {
    $('#settingsPanel').classList.add('active');
  });

  $('#settingsClose').addEventListener('click', () => {
    $('#settingsPanel').classList.remove('active');
  });

  $('#settingsPanel').addEventListener('click', (e) => {
    if (e.target === $('#settingsPanel')) $('#settingsPanel').classList.remove('active');
  });

  $('#deleteAllData').addEventListener('click', () => {
    if (confirm('Alle lokalen Daten und den Cache löschen? Dies kann nicht rückgängig gemacht werden.')) {
      // Clear all SkyAlert data
      const keys = Object.keys(localStorage).filter(k => k.startsWith('skyalert'));
      keys.forEach(k => localStorage.removeItem(k));
      location.reload();
    }
  });

  $('#showDsgvo').addEventListener('click', () => {
    $('#settingsPanel').classList.remove('active');
    $('#dsgvoOverlay').classList.remove('hidden');
  });

  $('#settingAutoRefresh').addEventListener('change', (e) => {
    localStorage.setItem('skyalert_auto_refresh', String(e.target.checked));
    if (e.target.checked) {
      startRefreshCycle();
    } else {
      stopRefreshCycle();
      updateFreshnessBarManual();
    }
  });

  $('#markAllRead').addEventListener('click', () => {
    alerts.forEach(a => a.unread = false);
    saveAlerts();
    renderAlerts();
  });
}

// ===== MANUAL REFRESH =====
function initManualRefresh() {
  $('#manualRefreshBtn').addEventListener('click', async () => {
    const btn = $('#manualRefreshBtn');
    btn.classList.add('spinning');
    btn.disabled = true;

    try {
      await loadInitialData();
    } finally {
      btn.classList.remove('spinning');
      btn.disabled = false;
    }
  });
}

// ===== API KEY SETTINGS =====
function initApiKeySettings() {
  // Show current API key status
  updateApiKeyStatus();

  // Load existing custom key into input (masked)
  if (AviationAPI.hasCustomApiKey()) {
    const key = AviationAPI.getActiveApiKey();
    $('#customApiKey').value = key.substring(0, 6) + '...' + key.substring(key.length - 4);
  }

  // Save custom key
  $('#saveApiKey').addEventListener('click', () => {
    const input = $('#customApiKey');
    const key = input.value.trim();

    if (AviationAPI.setCustomApiKey(key)) {
      updateApiKeyStatus();
      // Clear caches so new key is used
      const keys = Object.keys(localStorage).filter(k => k.startsWith('skyalert_cache_'));
      keys.forEach(k => localStorage.removeItem(k));
      alert('\u2705 API-Key gespeichert! Der Cache wurde geleert. Klicke auf \u21bb, um mit deinem Key Daten zu laden.');
      // Mask the key
      input.value = key.substring(0, 6) + '...' + key.substring(key.length - 4);
    } else {
      alert('\u274c Ung\u00fcltiger API-Key. Der Key muss mindestens 10 Zeichen lang sein.');
    }
  });

  // Reset to default
  $('#resetApiKey').addEventListener('click', () => {
    AviationAPI.removeCustomApiKey();
    $('#customApiKey').value = '';
    updateApiKeyStatus();
    // Clear caches
    const keys = Object.keys(localStorage).filter(k => k.startsWith('skyalert_cache_'));
    keys.forEach(k => localStorage.removeItem(k));
    alert('Standard-Key wiederhergestellt.');
  });
}

function updateApiKeyStatus() {
  const dot = $('.api-key-dot');
  const text = $('#apiKeyStatusText');

  if (AviationAPI.hasCustomApiKey()) {
    dot.className = 'api-key-dot custom';
    text.textContent = 'Eigener Key aktiv';
    text.style.color = 'var(--accent-cyan)';
  } else {
    dot.className = 'api-key-dot active';
    text.textContent = 'Standard-Key aktiv (gemeinsames Kontingent)';
    text.style.color = 'var(--text-muted)';
  }
}

// ===== MODAL =====
function initModalHandlers() {
  $('#flightDetailModal').addEventListener('click', (e) => {
    if (e.target === $('#flightDetailModal')) closeModal('flightDetailModal');
  });
  $('#modalClose').addEventListener('click', () => closeModal('flightDetailModal'));
}

function closeModal(id) {
  $(`#${id}`).classList.remove('active');
}

// ===== ONLINE STATUS =====
function initOnlineStatus() {
  window.addEventListener('online', () => {
    isOnline = true;
    updateRefreshIndicator('live');
    loadInitialData();
    startRefreshCycle();
  });

  window.addEventListener('offline', () => {
    isOnline = false;
    updateRefreshIndicator('offline');
    stopRefreshCycle();
  });
}

function updateRefreshIndicator(state) {
  const indicator = $('#refreshIndicator');
  const text = $('#refreshText');
  indicator.classList.remove('updating', 'offline');

  switch (state) {
    case 'live':
      text.textContent = 'Live';
      break;
    case 'updating':
      indicator.classList.add('updating');
      text.textContent = 'Lädt...';
      break;
    case 'offline':
      indicator.classList.add('offline');
      text.textContent = 'Offline';
      break;
  }
}

// ===== REFRESH CYCLE =====
function startRefreshCycle() {
  stopRefreshCycle();
  refreshCountdown = REFRESH_INTERVALS.flightStatus;
  updateFreshnessBar();

  refreshTimerId = setInterval(() => {
    refreshCountdown--;
    updateFreshnessBar();

    if (refreshCountdown <= 0) {
      performRefresh();
      refreshCountdown = REFRESH_INTERVALS.flightStatus;
    }
  }, 1000);
}

function stopRefreshCycle() {
  if (refreshTimerId) {
    clearInterval(refreshTimerId);
    refreshTimerId = null;
  }
}

function updateFreshnessBar() {
  const elapsed = Math.floor((Date.now() - lastRefreshTime) / 1000);
  const freshnessTime = $('#freshnessTime');
  const freshnessNext = $('#freshnessNext');
  const progress = $('#freshnessProgress');

  if (elapsed < 5) freshnessTime.textContent = 'gerade eben';
  else if (elapsed < 60) freshnessTime.textContent = `vor ${elapsed}s`;
  else freshnessTime.textContent = `vor ${Math.floor(elapsed / 60)} Min.`;

  const mins = Math.floor(refreshCountdown / 60);
  const secs = refreshCountdown % 60;
  freshnessNext.textContent = mins > 0 ? `Nächste in ${mins}m ${secs}s` : `Nächste in ${secs}s`;

  const pct = ((REFRESH_INTERVALS.flightStatus - refreshCountdown) / REFRESH_INTERVALS.flightStatus) * 100;
  progress.style.width = pct + '%';
}

async function performRefresh() {
  if (!isOnline) return;
  updateRefreshIndicator('updating');

  try {
    const result = await AviationAPI.getAllFlights();
    if (result.data && result.data.length > 0) {
      currentFlights = result.data.map(AviationAPI.transformFlight);
      airlineStats = AviationAPI.computeAirlineStats(currentFlights);
      generateAlertsFromFlights(currentFlights);
      renderAll();
    }
    lastRefreshTime = Date.now();
    updateRefreshIndicator('live');
  } catch (err) {
    console.error('[SkyAlert] Refresh failed:', err);
  }

  updateQuotaDisplay();
}

// ===== QUOTA DISPLAY =====
function updateQuotaDisplay() {
  const count = AviationAPI.getRequestCount();

  // Text display on home page
  const el = $('#apiQuotaText');
  if (el) {
    el.textContent = `${count} / 500 API-Requests diesen Monat`;
    el.style.color = count > 400 ? 'var(--status-red)' : count > 250 ? 'var(--status-yellow)' : 'var(--text-muted)';
  }

  // Data source quota counter
  const dsQuota = $('#dsQuotaUsed');
  if (dsQuota) dsQuota.textContent = String(count);

  // Refresh mode indicator
  const dsMode = $('#dsRefreshMode');
  if (dsMode) {
    const isAuto = localStorage.getItem('skyalert_auto_refresh') === 'true';
    dsMode.textContent = isAuto ? 'Auto (3min)' : 'Manuell';
  }

  // Settings quota bar
  const quotaBar = $('#quotaBarFill');
  const quotaUsed = $('#quotaUsed');
  if (quotaBar) {
    const pct = Math.min((count / 500) * 100, 100);
    quotaBar.style.width = pct + '%';
    quotaBar.style.background = count > 400 ? 'var(--status-red)' : count > 250 ? 'var(--status-yellow)' : 'var(--accent-blue)';
  }
  if (quotaUsed) quotaUsed.textContent = String(count);

  // Show warning if quota is running low
  if (count >= 450) {
    showQuotaWarning(count);
  }
}

function showQuotaWarning(count) {
  const banner = $('#disruptionBanner');
  if (count >= 500) {
    banner.style.display = 'block';
    banner.querySelector('.disruption-text').textContent = 'API-Kontingent aufgebraucht! Eigenen Key in den Einstellungen eintragen.';
    banner.querySelector('.disruption-label').textContent = '\u26a0\ufe0f API-Limit erreicht · ' + count + ' / 500 Requests';
  }
}

function updateFreshnessBarManual() {
  const freshnessTime = $('#freshnessTime');
  const freshnessNext = $('#freshnessNext');
  const progress = $('#freshnessProgress');

  if (lastRefreshTime) {
    const elapsed = Math.floor((Date.now() - lastRefreshTime) / 1000);
    if (elapsed < 5) freshnessTime.textContent = 'gerade eben';
    else if (elapsed < 60) freshnessTime.textContent = `vor ${elapsed}s`;
    else freshnessTime.textContent = `vor ${Math.floor(elapsed / 60)} Min.`;
  } else {
    freshnessTime.textContent = '—';
  }

  freshnessNext.textContent = '\u21bb Manuell aktualisieren';
  if (progress) progress.style.width = '0%';
}

// ===== RENDER ALL =====
function renderAll() {
  renderTrending();
  renderRecentSearches();
  renderWatchlist();
  renderAirlines();
  renderAlerts();
  updateWatchlistBadge();
  updateAlertsBadge();
  updateDisruptionBanner();
}

// ===== RENDER TRENDING =====
function renderTrending() {
  const list = $('#trendingList');
  if (currentFlights.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✈️</div>
        <div class="empty-text">Flugdaten werden geladen...</div>
      </div>
    `;
    return;
  }

  // Sort: cancelled first, then delayed, then by delay amount
  const sorted = [...currentFlights].sort((a, b) => {
    const priority = { cancelled: 0, majordelay: 1, delayed: 2, ontime: 3 };
    return (priority[a.status] || 3) - (priority[b.status] || 3) || (b.delay || 0) - (a.delay || 0);
  });

  const display = sorted.slice(0, 20);
  list.innerHTML = display.map(f => createFlightCard(f)).join('');
  $('#trendingCount').textContent = `${currentFlights.length} Flüge`;
}

function createFlightCard(f) {
  const updateAge = getTimeAgo(f.lastUpdate);

  let delayInfo = '';
  if (f.status === 'cancelled') {
    delayInfo = `<div class="fc-delay-info" style="color: var(--status-red);">Storniert · ${updateAge}</div>`;
  } else if (f.hasLive) {
    const alt = f.altitude ? `FL${Math.round(f.altitude / 30.48)}` : '';
    const spd = f.speed ? `${f.speed} km/h` : '';
    delayInfo = `<div class="fc-delay-info" style="color: var(--accent-cyan);">🛩️ Live: ${[alt, spd].filter(Boolean).join(' · ')} · ${updateAge}</div>`;
  } else if (f.delay > 0) {
    delayInfo = `<div class="fc-delay-info prediction">⏱️ +${f.delay}min Verspätung · ${updateAge}</div>`;
  } else {
    delayInfo = `<div class="fc-delay-info" style="color: var(--status-green);">Planmäßig · ${updateAge}</div>`;
  }

  return `
    <div class="flight-card status-${f.status}" onclick="openFlightDetail('${f.numberRaw}')">
      <div class="fc-top">
        <div>
          <span class="fc-flight-number">${f.number}</span>
          <span class="fc-airline">${f.airline}</span>
        </div>
        <span class="fc-status ${f.status}">${f.statusText}</span>
      </div>
      <div class="fc-route">
        <div class="fc-airport">
          <div class="fc-airport-code">${f.from}</div>
          <div class="fc-airport-city">${truncate(f.fromCity, 18)}</div>
        </div>
        <div class="fc-route-line"><span class="plane-icon">✈️</span></div>
        <div class="fc-airport">
          <div class="fc-airport-code">${f.to}</div>
          <div class="fc-airport-city">${truncate(f.toCity, 18)}</div>
        </div>
      </div>
      <div class="fc-times">
        <span>Abflug: ${f.depTime}${f.depTimeEst !== f.depTime ? ` → ${f.depTimeEst}` : ''}</span>
        <span>Ankunft: ${f.arrTime}${f.arrTimeEst !== f.arrTime ? ` → ${f.arrTimeEst}` : ''}</span>
      </div>
      ${delayInfo}
    </div>
  `;
}

// ===== UPDATE DISRUPTION BANNER =====
function updateDisruptionBanner() {
  const cancelled = currentFlights.filter(f => f.status === 'cancelled').length;
  const delayed = currentFlights.filter(f => f.status === 'delayed' || f.status === 'majordelay').length;
  const total = cancelled + delayed;

  const banner = $('#disruptionBanner');
  if (total > 0) {
    banner.style.display = 'block';
    banner.querySelector('.disruption-text').textContent =
      `${cancelled > 0 ? `${cancelled} Stornierungen` : ''}${cancelled > 0 && delayed > 0 ? ' · ' : ''}${delayed > 0 ? `${delayed} Verspätungen` : ''}`;
    banner.querySelector('.disruption-label').textContent =
      `⚠️ ${total} betroffene Flüge · Aktualisiert ${getTimeAgo(lastRefreshTime)}`;
  } else {
    banner.style.display = 'none';
  }
}

// ===== RENDER RECENT SEARCHES =====
function renderRecentSearches() {
  const el = $('#recentList');
  if (!el) return;

  if (dsgvoConsent === 'minimal') {
    el.innerHTML = '<div style="padding: 12px 0; font-size: 0.78rem; color: var(--text-muted);">Suchverlauf deaktiviert (Datenschutz-Einstellung)</div>';
    return;
  }

  try {
    const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (recent.length === 0) {
      el.innerHTML = '<div style="padding: 12px 0; font-size: 0.78rem; color: var(--text-muted);">Noch keine Suchen</div>';
      return;
    }

    el.innerHTML = recent.map(r => `
      <div class="recent-item" onclick="document.getElementById('searchInput').value='${r.query}'; performSearch('${r.query}');">
        <span class="recent-icon">🔍</span>
        <span class="recent-text"><strong>${r.query.toUpperCase()}</strong> · ${getTimeAgo(r.time)}</span>
      </div>
    `).join('');
  } catch {
    el.innerHTML = '';
  }
}

// ===== RENDER WATCHLIST =====
function renderWatchlist() {
  const container = $('#watchlistContainer');

  if (watchlistFlights.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⭐</div>
        <div class="empty-text">Keine Flüge auf der Watchlist</div>
        <div class="empty-sub">Suche einen Flug und füge ihn zur Überwachung hinzu</div>
      </div>
    `;
    return;
  }

  container.innerHTML = watchlistFlights.map(w => {
    const updateAge = getTimeAgo(w.lastUpdate);
    // Estimate progress for active flights
    let progress = 0;
    let progressClass = 'green';
    if (w.flightStatus === 'active') progress = 50; // rough estimate
    if (w.status === 'cancelled') { progress = 0; progressClass = 'red'; }
    if (w.status === 'delayed' || w.status === 'majordelay') progressClass = 'yellow';

    return `
    <div class="watchlist-card status-${w.status}" onclick="openFlightDetail('${w.numberRaw}')">
      <div class="wc-header">
        <span class="wc-flight">${w.number} <span style="color: var(--text-muted); font-size: 0.72rem; font-weight: 400;">${w.airline}</span></span>
        <span class="fc-status ${w.status}">${w.statusText}</span>
      </div>
      <div class="wc-route">
        <span class="wc-route-from">${w.from}</span>
        <span class="wc-arrow">→</span>
        <span class="wc-route-to">${w.to}</span>
      </div>
      <div class="wc-details">
        <div class="wc-detail-item">🕐 ${w.depTime}</div>
        <div class="wc-detail-item">🚪 Gate ${w.gate}</div>
        <div class="wc-detail-item" style="color: var(--text-muted); font-size: 0.65rem;">⟳ ${updateAge}</div>
      </div>
      ${w.flightStatus === 'active' ? `
        <div class="wc-progress"><div class="wc-progress-bar ${progressClass}" style="width: ${progress}%;"></div></div>
        <div style="font-size: 0.65rem; color: var(--text-muted); margin-top: 4px;">${w.hasLive && w.altitude ? `FL${Math.round(w.altitude/30.48)} · ${w.speed || '—'} km/h` : 'In der Luft'}</div>
      ` : ''}
      <button class="watchlist-remove" onclick="event.stopPropagation(); removeFromWatchlist('${w.numberRaw}')">✕ Entfernen</button>
    </div>
    `;
  }).join('');
}

// ===== RENDER AIRLINES =====
function renderAirlines() {
  const container = $('#airlinesContainer');

  if (airlineStats.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✈️</div>
        <div class="empty-text">Airline-Daten laden...</div>
      </div>
    `;
    return;
  }

  container.innerHTML = airlineStats.map(a => `
    <div class="airline-card">
      <div class="al-header">
        <div><span class="al-name">${a.name}</span><span class="al-code">${a.code}</span></div>
        <span class="al-health ${a.health}">${a.healthText}</span>
      </div>
      <div class="al-stats">
        <div class="al-stat">
          <span class="al-stat-value ${a.health === 'good' ? 'green' : a.health === 'moderate' ? 'yellow' : 'red'}">${a.punctuality}</span>
          <span class="al-stat-label">Pünktlichkeit</span>
        </div>
        <div class="al-stat">
          <span class="al-stat-value yellow">${a.avgDelay}</span>
          <span class="al-stat-label">Ø Verspätung</span>
        </div>
        <div class="al-stat">
          <span class="al-stat-value red">${a.cancellations}</span>
          <span class="al-stat-label">Stornierungen</span>
        </div>
      </div>
    </div>
  `).join('');
}

// ===== RENDER ALERTS =====
function renderAlerts() {
  const container = $('#alertsContainer');

  if (alerts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔔</div>
        <div class="empty-text">Keine Benachrichtigungen</div>
        <div class="empty-sub">Statusänderungen von Flügen erscheinen hier automatisch</div>
      </div>
    `;
    return;
  }

  container.innerHTML = alerts.map(a => `
    <div class="alert-card ${a.unread ? 'unread' : ''}">
      <div class="alert-header">
        <span class="alert-type ${a.type}">${a.typeText}</span>
        <span class="alert-time">${a.time}</span>
      </div>
      <div class="alert-body">${a.body}</div>
    </div>
  `).join('');
}

// ===== NEWS =====
let newsRefreshTimer = null;

function initNewsFilters() {
  $$('.news-filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $$('.news-filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentNewsFilter = chip.dataset.filter;
      renderNews();
    });
  });
}

async function loadNews() {
  try {
    const result = await NewsAPI.fetchNews();
    newsArticles = result.articles || [];
    newsLoaded = true;
    renderNews();
    updateNewsBadge();

    // Schedule next refresh in 15 minutes
    if (newsRefreshTimer) clearTimeout(newsRefreshTimer);
    newsRefreshTimer = setTimeout(loadNews, 15 * 60 * 1000);

  } catch (err) {
    console.error('[SkyAlert] News load failed:', err);
    const container = $('#newsContainer');
    if (container) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📰</div>
          <div class="empty-text">Nachrichten konnten nicht geladen werden</div>
          <div class="empty-sub">${err.message}</div>
        </div>
      `;
    }
  }
}

function updateNewsBadge() {
  const badge = $('#newsBadge');
  if (newsArticles.length > 0) {
    badge.textContent = String(newsArticles.length);
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function renderNews() {
  const container = $('#newsContainer');
  if (!container) return;

  if (newsArticles.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="loading-spinner"></div>
        <div class="empty-text">Nachrichten werden geladen...</div>
      </div>
    `;
    return;
  }

  // Filter
  const filterMap = {
    'all': null,
    'flugverkehr': 'Flugverkehr',
    'israel': 'Israel/Gaza',
    'regional': 'Regionale Lage',
    'diplomatie': 'Diplomatie'
  };

  const filterValue = filterMap[currentNewsFilter];
  const filtered = filterValue
    ? newsArticles.filter(a => a.category === filterValue)
    : newsArticles;

  $('#newsCount').textContent = `${filtered.length} Artikel`;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-text">Keine Artikel in dieser Kategorie</div>
        <div class="empty-sub">Versuche einen anderen Filter</div>
      </div>
    `;
    return;
  }

  // Show breaking news ticker for most recent article
  const latestArticle = filtered[0];
  const recentEnough = latestArticle && (Date.now() - latestArticle.timestamp) < 3600000; // last hour
  const ticker = $('#newsTicker');
  if (recentEnough && ticker) {
    ticker.style.display = 'flex';
    $('#tickerContent').textContent = latestArticle.title;
  } else if (ticker) {
    ticker.style.display = 'none';
  }

  container.innerHTML = filtered.map((article, idx) => `
    <a href="${article.url}" target="_blank" rel="noopener noreferrer" class="news-card" style="animation-delay: ${Math.min(idx * 50, 300)}ms;">
      <div class="news-card-header">
        <span class="news-category">${article.categoryIcon} ${article.category}</span>
        <span class="news-time">${article.timeAgo}</span>
      </div>
      <h3 class="news-title">${article.title}</h3>
      ${article.excerpt ? `<p class="news-excerpt">${article.excerpt}</p>` : ''}
      <div class="news-footer">
        <span class="news-source">${article.source}</span>
        <span class="news-date">${article.pubDate} · ${article.pubTime}</span>
      </div>
    </a>
  `).join('');
}

// ===== FLIGHT DETAIL MODAL =====
window.openFlightDetail = function(flightIata) {
  // Find in currentFlights or watchlist
  let flight = currentFlights.find(f => f.numberRaw === flightIata) ||
               watchlistFlights.find(f => f.numberRaw === flightIata);

  if (!flight) {
    // Try to load from API
    loadFlightDetail(flightIata);
    return;
  }

  showFlightModal(flight);
};

async function loadFlightDetail(flightIata) {
  try {
    const result = await AviationAPI.getFlightByIata(flightIata);
    updateQuotaDisplay();
    if (result.data && result.data.length > 0) {
      const flight = AviationAPI.transformFlight(result.data[0]);
      showFlightModal(flight);
    } else {
      alert('Flug nicht gefunden.');
    }
  } catch (err) {
    alert(`Fehler: ${err.message}`);
  }
}

function showFlightModal(flight) {
  const f = flight;
  const statusColors = { ontime: 'var(--status-green)', delayed: 'var(--status-yellow)', majordelay: 'var(--status-orange)', cancelled: 'var(--status-red)' };
  const updateAge = getTimeAgo(f.lastUpdate);
  const isInWatchlist = watchlistFlights.some(w => w.numberRaw === f.numberRaw);

  let liveSection = '';
  if (f.hasLive) {
    liveSection = `
      <div class="modal-prediction" style="border-color: rgba(6,182,212,0.2);">
        <div class="modal-prediction-title">🛩️ Live-Tracking</div>
        <div class="modal-prediction-text">
          ${f.altitude ? `Höhe: <strong>FL${Math.round(f.altitude / 30.48)}</strong> (${Math.round(f.altitude)}m)` : ''}
          ${f.speed ? ` · Geschwindigkeit: <strong>${f.speed} km/h</strong>` : ''}
          ${f.latitude ? `<br/>Position: ${f.latitude.toFixed(4)}° N, ${Math.abs(f.longitude).toFixed(4)}° ${f.longitude >= 0 ? 'E' : 'W'}` : ''}
          ${f.isGround ? '<br/>📍 Am Boden' : ''}
        </div>
      </div>
    `;
  }

  let cancelSection = '';
  if (f.status === 'cancelled') {
    cancelSection = `
      <div class="modal-prediction" style="border-color: rgba(239,68,68,0.2); background: linear-gradient(135deg, rgba(239,68,68,0.08), rgba(249,115,22,0.05));">
        <div class="modal-prediction-title" style="color: var(--status-red);">⚠️ Flug storniert</div>
        <div class="modal-prediction-text">
          Dieser Flug wurde storniert. Besuchen Sie die Website von <strong>${f.airline}</strong> für Umbuchungsoptionen.
        </div>
      </div>
    `;
  }

  $('#modalBody').innerHTML = `
    <div class="modal-flight-number">${f.number}</div>
    <div class="modal-airline">${f.airline} · ${f.flightDate || ''} · ${updateAge}</div>
    <div style="display: inline-block; margin-bottom: 16px;">
      <span class="fc-status ${f.status}">${f.statusText}</span>
    </div>

    <div class="modal-route">
      <div class="modal-airport">
        <div class="modal-airport-code">${f.from}</div>
        <div class="modal-airport-name">${truncate(f.fromCity, 22)}</div>
        <div class="modal-airport-time">${f.depTime}${f.depTimeEst !== f.depTime ? ` → ${f.depTimeEst}` : ''}</div>
      </div>
      <div class="modal-route-center">
        <div class="modal-duration">${f.aircraft !== '—' ? f.aircraft : ''}</div>
        <div class="modal-plane">✈️</div>
        <div class="modal-distance">${f.distance}</div>
      </div>
      <div class="modal-airport">
        <div class="modal-airport-code">${f.to}</div>
        <div class="modal-airport-name">${truncate(f.toCity, 22)}</div>
        <div class="modal-airport-time">${f.arrTime}${f.arrTimeEst !== f.arrTime ? ` → ${f.arrTimeEst}` : ''}</div>
      </div>
    </div>

    <div class="modal-info-grid">
      <div class="modal-info-item">
        <div class="modal-info-label">Gate</div>
        <div class="modal-info-value">${f.gate}</div>
      </div>
      <div class="modal-info-item">
        <div class="modal-info-label">Terminal</div>
        <div class="modal-info-value">${f.terminal}</div>
      </div>
      <div class="modal-info-item">
        <div class="modal-info-label">Verspätung</div>
        <div class="modal-info-value" style="color: ${statusColors[f.status] || 'inherit'}">${f.delay ? `+${f.delay} Min.` : f.status === 'cancelled' ? 'Storniert' : 'Keine'}</div>
      </div>
      <div class="modal-info-item">
        <div class="modal-info-label">Flugzeug</div>
        <div class="modal-info-value">${f.aircraft}</div>
      </div>
    </div>

    ${liveSection}
    ${cancelSection}

    <div class="modal-actions">
      <button class="modal-action-btn primary" onclick="${isInWatchlist ? `removeFromWatchlist('${f.numberRaw}'); closeModal('flightDetailModal');` : `addToWatchlist('${f.numberRaw}')`}">
        ${isInWatchlist ? '✕ Von Watchlist entfernen' : '⭐ Zur Watchlist'}
      </button>
      <button class="modal-action-btn" onclick="shareFlightLink('${f.numberRaw}')">🔗 Teilen</button>
    </div>
  `;

  $('#flightDetailModal').classList.add('active');
}

window.addToWatchlist = function(flightIata) {
  const flight = currentFlights.find(f => f.numberRaw === flightIata);
  if (!flight) return;

  if (!watchlistFlights.some(w => w.numberRaw === flightIata)) {
    watchlistFlights.push({ ...flight });
    saveWatchlist();
    renderWatchlist();
    closeModal('flightDetailModal');
  }
};

window.removeFromWatchlist = function(flightIata) {
  watchlistFlights = watchlistFlights.filter(w => w.numberRaw !== flightIata);
  saveWatchlist();
  renderWatchlist();
};

window.shareFlightLink = function(flightIata) {
  const url = `${location.origin}?flight=${flightIata}`;
  if (navigator.share) {
    navigator.share({ title: `Flugstatus ${AviationAPI.formatFlightNumber(flightIata)}`, text: `Verfolge den aktuellen Status von Flug ${AviationAPI.formatFlightNumber(flightIata)}`, url });
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(url);
    alert(`📋 Link kopiert!\n${url}`);
  }
};

// Make performSearch global for recent search clicks
window.performSearch = performSearch;

// ===== PWA =====
function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(reg => console.log('[SkyAlert] SW registriert:', reg.scope))
      .catch(err => console.warn('[SkyAlert] SW Fehler:', err));
  }

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('#pwaInstallBanner').style.display = 'flex';
  });

  $('#pwaInstallBtn')?.addEventListener('click', () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(() => {
        deferredPrompt = null;
        $('#pwaInstallBanner').style.display = 'none';
      });
    }
  });

  $('#pwaInstallDismiss')?.addEventListener('click', () => {
    $('#pwaInstallBanner').style.display = 'none';
  });

  // Handle ?flight= URL parameter
  const params = new URLSearchParams(window.location.search);
  const flightParam = params.get('flight');
  if (flightParam) {
    setTimeout(() => {
      performSearch(flightParam);
    }, 1500);
  }
}

// ===== WORLD MAP =====
function drawWorldMap() {
  const canvas = document.getElementById('worldMap');
  if (!canvas) return;

  const container = canvas.parentElement;
  const W = container.clientWidth;
  const H = container.clientHeight;

  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  ctx.fillStyle = '#0d1320';
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = 'rgba(59,130,246,0.05)';
  ctx.lineWidth = 0.5;
  for (let x = 0; x < W; x += 30) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = 0; y < H; y += 30) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

  const sx = W / 390;
  const sy = H / 280;

  ctx.fillStyle = 'rgba(59,130,246,0.07)';
  ctx.strokeStyle = 'rgba(59,130,246,0.12)';
  ctx.lineWidth = 1;

  const continents = [
    [[140,50],[170,45],[195,50],[220,55],[230,60],[245,65],[260,70],[265,85],[255,95],[240,100],[220,105],[200,110],[180,105],[160,98],[145,90],[135,75],[140,60]],
    [[150,115],[175,110],[200,115],[220,120],[235,130],[245,150],[240,180],[230,210],[215,235],[200,248],[185,250],[170,240],[160,220],[150,195],[145,170],[140,145],[142,125]],
    [[250,85],[270,80],[290,85],[310,95],[315,110],[320,125],[310,140],[295,145],[280,140],[268,130],[258,120],[248,105],[245,95]],
    [[270,55],[300,45],[330,50],[360,55],[380,65],[385,85],[375,105],[360,115],[340,120],[320,115],[310,100],[295,80],[280,65]]
  ];

  continents.forEach(pts => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0]*sx, pts[0][1]*sy);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i-1], curr = pts[i];
      ctx.quadraticCurveTo(prev[0]*sx, prev[1]*sy, (prev[0]+curr[0])/2*sx, (prev[1]+curr[1])/2*sy);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
  });

  // Plot live flights on map if available
  const liveFlights = currentFlights.filter(f => f.hasLive && f.latitude && f.longitude);
  liveFlights.forEach(f => {
    // Convert lat/lon to pixel (very rough Mercator)
    const px = ((f.longitude + 180) / 360) * W;
    const py = ((90 - f.latitude) / 180) * H;

    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = f.status === 'cancelled' ? '#ef4444' : f.status === 'delayed' ? '#eab308' : '#22c55e';
    ctx.globalAlpha = 0.2;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(px, py, 2, 0, Math.PI * 2);
    ctx.fillStyle = f.status === 'cancelled' ? '#ef4444' : f.status === 'delayed' ? '#eab308' : '#22c55e';
    ctx.fill();

    ctx.font = `${Math.max(6, 7*Math.min(sx,sy))}px Inter, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'center';
    ctx.fillText(f.number.replace(' ',''), px, py - 6);
  });

  // Static airports if no live data
  if (liveFlights.length === 0) {
    const airports = [
      {x:170,y:85,color:'#60a5fa',label:'FRA'},{x:175,y:80,color:'#60a5fa',label:'MUC'},
      {x:260,y:75,color:'#60a5fa',label:'IST'},{x:290,y:110,color:'#ef4444',label:'TLV'},
      {x:265,y:120,color:'#eab308',label:'BEY'},{x:280,y:115,color:'#eab308',label:'AMM'},
      {x:310,y:125,color:'#22c55e',label:'DOH'},{x:320,y:120,color:'#22c55e',label:'DXB'}
    ];
    airports.forEach(a => {
      ctx.save(); ctx.beginPath(); ctx.arc(a.x*sx,a.y*sy,5,0,Math.PI*2);
      ctx.fillStyle=a.color; ctx.globalAlpha=0.15; ctx.fill(); ctx.restore();
      ctx.beginPath(); ctx.arc(a.x*sx,a.y*sy,2.5,0,Math.PI*2); ctx.fillStyle=a.color; ctx.fill();
      ctx.font=`${Math.max(7,8*Math.min(sx,sy))}px Inter, sans-serif`;
      ctx.fillStyle='rgba(255,255,255,0.6)'; ctx.textAlign='center';
      ctx.fillText(a.label, a.x*sx, a.y*sy-7);
    });
  }
}

window.addEventListener('resize', () => {
  if ($('#pageMap').classList.contains('active')) drawWorldMap();
});

// ===== UI HELPERS =====
function showLoadingState(msg) {
  isLoading = true;
  const list = $('#trendingList');
  if (list) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="loading-spinner"></div>
        <div class="empty-text">${msg}</div>
      </div>
    `;
  }
}

function hideLoadingState() {
  isLoading = false;
}

function showTrendingLoading() {
  $('#trendingList').innerHTML = `
    <div class="empty-state">
      <div class="loading-spinner"></div>
      <div class="empty-text">Suche läuft...</div>
    </div>
  `;
}

function showError(msg) {
  $('#trendingList').innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <div class="empty-text">${msg}</div>
    </div>
  `;
}

function getTimeAgo(timestamp) {
  if (!timestamp) return '';
  const secs = Math.floor((Date.now() - timestamp) / 1000);
  if (secs < 10) return 'gerade eben';
  if (secs < 60) return `vor ${secs}s`;
  if (secs < 3600) return `vor ${Math.floor(secs / 60)} Min.`;
  return `vor ${Math.floor(secs / 3600)} Std.`;
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '…' : str;
}
