// ============================================================
// SkyAlert — AviationStack API Client
// Produktive Anbindung mit intelligentem Caching
// ============================================================

const AviationAPI = (() => {
  const DEFAULT_API_KEY = 'c62e19481cff365b50173723adc49017';
  const CUSTOM_KEY_STORAGE = 'skyalert_custom_api_key';
  const BASE_URL = 'https://api.aviationstack.com/v1';

  function getActiveApiKey() {
    return localStorage.getItem(CUSTOM_KEY_STORAGE) || DEFAULT_API_KEY;
  }

  function setCustomApiKey(key) {
    if (key && key.trim().length > 10) {
      localStorage.setItem(CUSTOM_KEY_STORAGE, key.trim());
      return true;
    }
    return false;
  }

  function removeCustomApiKey() {
    localStorage.removeItem(CUSTOM_KEY_STORAGE);
  }

  function hasCustomApiKey() {
    return !!localStorage.getItem(CUSTOM_KEY_STORAGE);
  }

  // Cache-TTL in Millisekunden
  const CACHE_TTL = {
    flights: 3 * 60 * 1000,       // 3 Minuten für Flugstatus
    search: 5 * 60 * 1000,        // 5 Minuten für Suchergebnisse
    airlines: 30 * 60 * 1000,     // 30 Minuten für Airline-Daten
    airports: 60 * 60 * 1000      // 1 Stunde für Flughäfen
  };

  // Request-Zähler (pro Monat 500 im Free-Tier)
  const STORAGE_KEY_COUNTER = 'skyalert_api_counter';
  const STORAGE_KEY_COUNTER_MONTH = 'skyalert_api_counter_month';

  function getRequestCount() {
    const currentMonth = new Date().getMonth();
    const savedMonth = parseInt(localStorage.getItem(STORAGE_KEY_COUNTER_MONTH) || '-1');
    if (savedMonth !== currentMonth) {
      localStorage.setItem(STORAGE_KEY_COUNTER, '0');
      localStorage.setItem(STORAGE_KEY_COUNTER_MONTH, String(currentMonth));
      return 0;
    }
    return parseInt(localStorage.getItem(STORAGE_KEY_COUNTER) || '0');
  }

  function incrementRequestCount() {
    const count = getRequestCount() + 1;
    localStorage.setItem(STORAGE_KEY_COUNTER, String(count));
    return count;
  }

  // ===== CACHE =====
  function getCached(key) {
    try {
      const raw = localStorage.getItem(`skyalert_cache_${key}`);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (Date.now() - cached.timestamp > cached.ttl) {
        localStorage.removeItem(`skyalert_cache_${key}`);
        return null;
      }
      return cached.data;
    } catch {
      return null;
    }
  }

  function setCache(key, data, ttl) {
    try {
      localStorage.setItem(`skyalert_cache_${key}`, JSON.stringify({
        data,
        timestamp: Date.now(),
        ttl
      }));
    } catch (e) {
      console.warn('[SkyAlert] Cache write failed:', e);
    }
  }

  // ===== API CALL =====
  async function apiCall(endpoint, params = {}, cacheKey = null, cacheTTL = CACHE_TTL.flights) {
    // Check cache first
    if (cacheKey) {
      const cached = getCached(cacheKey);
      if (cached) {
        console.log(`[SkyAlert] Cache hit: ${cacheKey}`);
        return { data: cached, fromCache: true, requestCount: getRequestCount() };
      }
    }

    // Check if online
    if (!navigator.onLine) {
      throw new Error('OFFLINE');
    }

    // Build URL
    const url = new URL(`${BASE_URL}/${endpoint}`);
    url.searchParams.set('access_key', getActiveApiKey());
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== '') {
        url.searchParams.set(k, v);
      }
    });

    console.log(`[SkyAlert] API Request: ${endpoint}`, params);

    try {
      const response = await fetch(url.toString());
      const json = await response.json();

      if (json.error) {
        console.error('[SkyAlert] API Error:', json.error);
        throw new Error(json.error.message || json.error.code || 'API Error');
      }

      const reqCount = incrementRequestCount();

      // Cache result
      if (cacheKey && json.data) {
        setCache(cacheKey, json.data, cacheTTL);
      }

      return {
        data: json.data || [],
        pagination: json.pagination || {},
        fromCache: false,
        requestCount: reqCount
      };
    } catch (err) {
      // On network error, try to return stale cache
      if (cacheKey) {
        try {
          const raw = localStorage.getItem(`skyalert_cache_${cacheKey}`);
          if (raw) {
            const cached = JSON.parse(raw);
            console.warn(`[SkyAlert] Returning stale cache for: ${cacheKey}`);
            return { data: cached.data, fromCache: true, stale: true, requestCount: getRequestCount() };
          }
        } catch {}
      }
      throw err;
    }
  }

  // ===== PUBLIC API =====

  /**
   * Fetch flights by departure or arrival airport
   */
  async function getFlightsByAirport(iataCode, direction = 'dep') {
    const paramKey = direction === 'dep' ? 'dep_iata' : 'arr_iata';
    return apiCall('flights', {
      [paramKey]: iataCode,
      limit: 30
    }, `flights_${direction}_${iataCode}`, CACHE_TTL.flights);
  }

  /**
   * Search for a specific flight by IATA code (e.g., "LH690")
   */
  async function getFlightByIata(flightIata, dateStr) {
    const cleaned = flightIata.replace(/\s/g, '').toUpperCase();
    const params = { flight_iata: cleaned, limit: 5 };
    if (dateStr) params.flight_date = dateStr;
    return apiCall('flights', params, `flight_${cleaned}_${dateStr || 'default'}`, CACHE_TTL.flights);
  }

  /**
   * Fetch all flights (global view - no airport filter)
   * Returns a broad mix of global flights for the home screen
   */
  async function getAllFlights() {
    return apiCall('flights', {
      limit: 100
    }, 'flights_all_global', CACHE_TTL.flights);
  }

  /**
   * Fetch flights related to Middle East for disruption tracking
   */
  async function getMiddleEastFlights() {
    return apiCall('flights', {
      arr_iata: 'TLV',
      limit: 50
    }, 'flights_middleeast_tlv', CACHE_TTL.flights);
  }

  /**
   * Fetch flights by precise route (origin -> destination)
   */
  async function getFlightsByRoute(depIata, arrIata) {
    const params = { limit: 30 };
    if (depIata) params.dep_iata = depIata;
    if (arrIata) params.arr_iata = arrIata;
    
    return apiCall('flights', params, `flights_route_${depIata}_${arrIata}`, CACHE_TTL.flights);
  }

  /**
   * Fetch flights to a specific destination (for loading grouped by destination)
   */
  async function getFlightsToDestination(arrIata) {
    return apiCall('flights', {
      arr_iata: arrIata,
      limit: 30
    }, `flights_to_${arrIata}`, CACHE_TTL.flights);
  }

  /**
   * Fetch flights from a specific origin
   */
  async function getFlightsFromOrigin(depIata) {
    return apiCall('flights', {
      dep_iata: depIata,
      limit: 30
    }, `flights_from_${depIata}`, CACHE_TTL.flights);
  }

  /**
   * Fetch active (in-air) flights for a specific airline
   */
  async function getActiveFlightsByAirline(airlineIata) {
    return apiCall('flights', {
      airline_iata: airlineIata,
      flight_status: 'active',
      limit: 20
    }, `flights_airline_active_${airlineIata}`, CACHE_TTL.flights);
  }

  /**
   * Fetch cancelled flights (for disruption tracking)
   */
  async function getCancelledFlights() {
    return apiCall('flights', {
      flight_status: 'cancelled',
      limit: 50
    }, 'flights_cancelled', CACHE_TTL.flights);
  }

  /**
   * General search — tries flight IATA first, then airport
   */
  async function search(query, dateStr) {
    const cleaned = query.trim().replace(/\s/g, '').toUpperCase();

    // If looks like a flight number (letters + numbers), search as flight
    if (/^[A-Z]{2}\d{1,5}$/.test(cleaned)) {
      return getFlightByIata(cleaned, dateStr);
    }

    // If looks like an IATA airport code (3 letters)
    if (/^[A-Z]{3}$/.test(cleaned)) {
      return getFlightsByAirport(cleaned, 'dep');
    }

    // Try as flight number anyway
    return getFlightByIata(cleaned, dateStr);
  }

  // ===== TRANSFORM HELPERS =====

  /**
   * Transform AviationStack flight object to SkyAlert internal format
   */
  function transformFlight(raw) {
    const dep = raw.departure || {};
    const arr = raw.arrival || {};
    const airline = raw.airline || {};
    const flight = raw.flight || {};
    const aircraft = raw.aircraft || {};
    const live = raw.live || {};

    // Determine status
    let status = 'ontime';
    let statusText = 'Planmäßig';
    const depDelay = dep.delay || 0;
    const arrDelay = arr.delay || 0;
    const maxDelay = Math.max(depDelay, arrDelay);

    switch (raw.flight_status) {
      case 'cancelled':
        status = 'cancelled';
        statusText = 'Storniert';
        break;
      case 'incident':
        status = 'cancelled';
        statusText = 'Zwischenfall';
        break;
      case 'diverted':
        status = 'majordelay';
        statusText = 'Umgeleitet';
        break;
      case 'active':
        if (maxDelay > 60) {
          status = 'majordelay';
          statusText = `Verspätet +${maxDelay}min`;
        } else if (maxDelay > 15) {
          status = 'delayed';
          statusText = `Verspätet +${maxDelay}min`;
        } else {
          status = 'ontime';
          statusText = 'In der Luft';
        }
        break;
      case 'landed':
        if (maxDelay > 60) {
          status = 'majordelay';
          statusText = `Gelandet (+${maxDelay}min)`;
        } else if (maxDelay > 15) {
          status = 'delayed';
          statusText = `Gelandet (+${maxDelay}min)`;
        } else {
          status = 'ontime';
          statusText = 'Gelandet';
        }
        break;
      case 'scheduled':
      default:
        if (maxDelay > 60) {
          status = 'majordelay';
          statusText = `Verspätet +${maxDelay}min`;
        } else if (maxDelay > 15) {
          status = 'delayed';
          statusText = `Verspätet +${maxDelay}min`;
        } else {
          status = 'ontime';
          statusText = 'Planmäßig';
        }
        break;
    }

    // Format times
    const depTime = formatTime(dep.scheduled);
    const arrTime = formatTime(arr.scheduled);
    const depTimeEst = dep.estimated ? formatTime(dep.estimated) : depTime;
    const arrTimeEst = arr.estimated ? formatTime(arr.estimated) : arrTime;

    // Build flight number display
    const flightNumber = flight.iata || `${airline.iata || '??'}${flight.number || ''}`;

    return {
      number: formatFlightNumber(flightNumber),
      numberRaw: flightNumber,
      airline: airline.name || 'Unbekannt',
      airlineIata: airline.iata || '',
      from: dep.iata || '???',
      fromCity: dep.airport || dep.iata || '',
      to: arr.iata || '???',
      toCity: arr.airport || arr.iata || '',
      depTime: depTime,
      arrTime: arrTime,
      depTimeEst: depTimeEst,
      arrTimeEst: arrTimeEst,
      status: status,
      statusText: statusText,
      delay: maxDelay,
      gate: dep.gate || '—',
      terminal: dep.terminal || '—',
      aircraft: aircraft.iata || '—',
      distance: '—',
      flightDate: raw.flight_date || '',
      flightStatus: raw.flight_status || 'scheduled',
      lastUpdate: Date.now(),
      // Live data
      hasLive: !!live.updated,
      latitude: live.latitude,
      longitude: live.longitude,
      altitude: live.altitude ? Math.round(live.altitude) : null,
      speed: live.speed_horizontal ? Math.round(live.speed_horizontal) : null,
      direction: live.direction,
      isGround: live.is_ground,
      // Raw for detail view
      _raw: raw
    };
  }

  function formatTime(isoString) {
    if (!isoString) return '—';
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '—';
    }
  }

  function formatFlightNumber(raw) {
    if (!raw) return '??';
    // Add space between letters and numbers: LH690 → LH 690
    return raw.replace(/^([A-Z]{2})(\d+)$/, '$1 $2');
  }

  /**
   * Compute airline stats from a list of transformed flights
   */
  function computeAirlineStats(flights) {
    const airlines = {};

    flights.forEach(f => {
      const key = f.airlineIata || f.airline;
      if (!airlines[key]) {
        airlines[key] = {
          name: f.airline,
          code: f.airlineIata,
          total: 0,
          ontime: 0,
          delayed: 0,
          cancelled: 0,
          totalDelay: 0,
          delayedCount: 0
        };
      }
      const a = airlines[key];
      a.total++;
      if (f.status === 'ontime') a.ontime++;
      if (f.status === 'delayed' || f.status === 'majordelay') {
        a.delayed++;
        a.totalDelay += f.delay || 0;
        a.delayedCount++;
      }
      if (f.status === 'cancelled') a.cancelled++;
    });

    return Object.values(airlines).map(a => {
      const punctuality = a.total > 0 ? Math.round((a.ontime / a.total) * 100) : 0;
      const avgDelay = a.delayedCount > 0 ? Math.round(a.totalDelay / a.delayedCount) : 0;
      let health = 'good';
      let healthText = 'Normal';
      if (punctuality < 60) { health = 'poor'; healthText = 'Gestört'; }
      else if (punctuality < 80) { health = 'moderate'; healthText = 'Eingeschränkt'; }

      return {
        name: a.name,
        code: a.code,
        health,
        healthText,
        punctuality: `${punctuality}%`,
        avgDelay: avgDelay > 0 ? `${avgDelay}min` : '0min',
        cancellations: String(a.cancelled),
        total: a.total
      };
    }).sort((a, b) => b.total - a.total);
  }

  // ===== PUBLIC INTERFACE =====
  return {
    getFlightsByAirport,
    getFlightByIata,
    getAllFlights,
    getMiddleEastFlights,
    getFlightsByRoute,
    getFlightsToDestination,
    getFlightsFromOrigin,
    getActiveFlightsByAirline,
    getCancelledFlights,
    search,
    transformFlight,
    computeAirlineStats,
    getRequestCount,
    getCached,
    setCache,
    CACHE_TTL,
    formatFlightNumber,
    // API Key management
    getActiveApiKey,
    setCustomApiKey,
    removeCustomApiKey,
    hasCustomApiKey
  };
})();

// ============================================================
// SkyAlert — News API Client (Google News RSS via rss2json)
// Aktuelle Nachrichten zum Nahost-Konflikt auf Deutsch
// ============================================================

const NewsAPI = (() => {
  const RSS2JSON_BASE = 'https://api.rss2json.com/v1/api.json';
  const CACHE_KEY = 'skyalert_cache_news';
  const CACHE_TTL = 15 * 60 * 1000; // 15 Minuten

  // Deutsche Suchbegriffe für relevante Nachrichten
  const SEARCH_TOPICS = [
    'Naher Osten Krieg Flüge',
    'Israel Gaza Flugverkehr',
    'Nahost Konflikt Luftraum',
    'Naher Osten Flugsperrung Airlines'
  ];

  /**
   * Fetch German news from Google News RSS
   */
  async function fetchNews() {
    // Check cache first
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
          console.log('[SkyAlert News] Cache hit');
          return { articles: cached.data, fromCache: true };
        }
      }
    } catch {}

    if (!navigator.onLine) {
      // Return stale cache if offline
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
          const cached = JSON.parse(raw);
          return { articles: cached.data, fromCache: true, stale: true };
        }
      } catch {}
      throw new Error('OFFLINE');
    }

    // Fetch from multiple topics and merge
    const allArticles = [];
    const seenTitles = new Set();

    for (const topic of SEARCH_TOPICS) {
      try {
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=de&gl=DE&ceid=DE:de`;
        const apiUrl = `${RSS2JSON_BASE}?rss_url=${encodeURIComponent(rssUrl)}&count=10`;

        const response = await fetch(apiUrl);
        const json = await response.json();

        if (json.status === 'ok' && json.items) {
          json.items.forEach(item => {
            // Deduplicate by title
            const titleKey = item.title.substring(0, 50).toLowerCase();
            if (!seenTitles.has(titleKey)) {
              seenTitles.add(titleKey);
              allArticles.push(transformArticle(item));
            }
          });
        }
      } catch (e) {
        console.warn(`[SkyAlert News] Fetch failed for topic "${topic}":`, e);
      }

      // Small delay between requests to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }

    // Sort by date (newest first)
    allArticles.sort((a, b) => b.timestamp - a.timestamp);

    // Keep only latest 30
    const result = allArticles.slice(0, 30);

    // Cache
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        data: result,
        timestamp: Date.now()
      }));
    } catch {}

    console.log(`[SkyAlert News] Loaded ${result.length} articles`);
    return { articles: result, fromCache: false };
  }

  /**
   * Transform RSS item to SkyAlert news format
   */
  function transformArticle(item) {
    // Extract source from title (Google News format: "Title - Source")
    let title = item.title || '';
    let source = 'Nachrichtenquelle';
    const dashIdx = title.lastIndexOf(' - ');
    if (dashIdx > 0) {
      source = title.substring(dashIdx + 3).trim();
      title = title.substring(0, dashIdx).trim();
    }

    // Parse date
    const pubDate = new Date(item.pubDate || Date.now());

    // Create excerpt from description (strip HTML)
    let excerpt = (item.description || '')
      .replace(/<[^>]*>/g, '')
      .replace(/&[^;]+;/g, ' ')
      .trim()
      .substring(0, 200);

    if (excerpt.length >= 200) excerpt += '…';

    // Determine category based on keywords
    let category = 'Nahost-Konflikt';
    let categoryIcon = '🌍';
    const lowerTitle = title.toLowerCase();

    if (lowerTitle.includes('flug') || lowerTitle.includes('airline') || lowerTitle.includes('luftraum') || lowerTitle.includes('sperrung')) {
      category = 'Flugverkehr';
      categoryIcon = '✈️';
    } else if (lowerTitle.includes('gaza') || lowerTitle.includes('israel') || lowerTitle.includes('hamas')) {
      category = 'Israel/Gaza';
      categoryIcon = '⚠️';
    } else if (lowerTitle.includes('iran') || lowerTitle.includes('libanon') || lowerTitle.includes('hisbollah')) {
      category = 'Regionale Lage';
      categoryIcon = '🔴';
    } else if (lowerTitle.includes('waffenstillstand') || lowerTitle.includes('friedens') || lowerTitle.includes('verhandlung')) {
      category = 'Diplomatie';
      categoryIcon = '🕊️';
    } else if (lowerTitle.includes('flüchtling') || lowerTitle.includes('humanitär') || lowerTitle.includes('hilfe')) {
      category = 'Humanitäre Lage';
      categoryIcon = '🏥';
    }

    return {
      title,
      source,
      excerpt,
      url: item.link || '#',
      category,
      categoryIcon,
      pubDate: pubDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      pubTime: pubDate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
      timeAgo: getRelativeTime(pubDate),
      timestamp: pubDate.getTime(),
      thumbnail: item.thumbnail || item.enclosure?.link || null
    };
  }

  function getRelativeTime(date) {
    const secs = Math.floor((Date.now() - date.getTime()) / 1000);
    if (secs < 60) return 'gerade eben';
    if (secs < 3600) return `vor ${Math.floor(secs / 60)} Min.`;
    if (secs < 86400) return `vor ${Math.floor(secs / 3600)} Std.`;
    return `vor ${Math.floor(secs / 86400)} Tagen`;
  }

  return { fetchNews };
})();
