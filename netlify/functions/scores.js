/**
 * Proxy for football-data.org API.
 * Returns { standings, fixtures, stages } in the format consumed by the DC app.
 * Cached at the Netlify CDN edge for 30 seconds to stay well within free-tier rate limits.
 */

const API_BASE = 'https://api.football-data.org/v4';

// TLA remaps: football-data.org TLA / ISO 2-letter → our FIFA app code
const TLA_REMAP = {
  // 2-letter ISO → FIFA (in case API returns ISO codes)
  MX:'MEX', KR:'KOR', CZ:'CZE', ZA:'RSA',
  CH:'SUI', BA:'BIH', CA:'CAN', QA:'QAT',
  MA:'MAR', BR:'BRA', HT:'HAI',
  US:'USA', AU:'AUS', TR:'TUR', PY:'PAR',
  DE:'GER', CI:'CIV', EC:'ECU', CW:'CUW',
  SE:'SWE', JP:'JPN', NL:'NED', TN:'TUN',
  NZ:'NZL', IR:'IRN', BE:'BEL', EG:'EGY',
  UY:'URU', SA:'KSA', ES:'ESP', CV:'CPV', URY:'URU',
  NO:'NOR', FR:'FRA', SN:'SEN', IQ:'IRQ',
  AR:'ARG', AT:'AUT', JO:'JOR', DZ:'ALG',
  CO:'COL', CD:'COD', PT:'POR', UZ:'UZB',
  GH:'GHA', PA:'PAN', HR:'CRO',
  // 3-letter mismatches
  HOL:'NED', NLD:'NED', JAP:'JPN', HTI:'HAI',
  CHE:'SUI', TUR:'TUR', PRK:'KOR', KOR:'KOR',
};

// Name-based fallback — API team names → our codes
const NAME_TO_CODE = {
  'Mexico':'MEX','South Korea':'KOR','Korea Republic':'KOR','Czechia':'CZE',
  'Czech Republic':'CZE','South Africa':'RSA','Switzerland':'SUI',
  'Bosnia & Herzegovina':'BIH','Bosnia and Herzegovina':'BIH','Canada':'CAN',
  'Qatar':'QAT','Scotland':'SCO','Morocco':'MAR','Brazil':'BRA','Haiti':'HAI',
  'United States':'USA','USA':'USA','Australia':'AUS','Turkey':'TUR',
  'Türkiye':'TUR','Paraguay':'PAR','Germany':'GER',"Côte d'Ivoire":'CIV',
  "Cote d'Ivoire":'CIV','Ivory Coast':'CIV','Ecuador':'ECU','Curaçao':'CUW',
  'Curacao':'CUW','Sweden':'SWE','Japan':'JPN','Netherlands':'NED',
  'Tunisia':'TUN','New Zealand':'NZL','Iran':'IRN','Belgium':'BEL',
  'Egypt':'EGY','Uruguay':'URU','Saudi Arabia':'KSA','Spain':'ESP',
  'Cape Verde':'CPV','Norway':'NOR','France':'FRA','Senegal':'SEN',
  'Iraq':'IRQ','Argentina':'ARG','Austria':'AUT','Jordan':'JOR',
  'Algeria':'ALG','Colombia':'COL','DR Congo':'COD','Congo DR':'COD',
  'Democratic Republic of Congo':'COD','Portugal':'POR','Uzbekistan':'UZB',
  'England':'ENG','Ghana':'GHA','Panama':'PAN','Croatia':'CRO',
};

function mapTla(tla, name) {
  const byTla = tla ? (TLA_REMAP[tla] || tla) : '';
  if (byTla && byTla.length === 3) return byTla;
  // Fall back to name lookup if TLA didn't resolve cleanly
  return (name && NAME_TO_CODE[name]) || byTla || '';
}

const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(utcDate) {
  const d = new Date(utcDate);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// Maps football-data.org stage names → our app's stage codes
// The app uses cumulative bonus: R32=2, R16=5, QF=10, SF=18, RU=30, W=50
// NOTE: football-data.org names the knockout stages LAST_32 / LAST_16
// (not ROUND_OF_32 / ROUND_OF_16). Using the wrong keys silently breaks
// knockout detection, so these must match the API exactly.
const STAGE_CODE = {
  LAST_32:        'R32',
  LAST_16:        'R16',
  QUARTER_FINALS: 'QF',
  SEMI_FINALS:    'SF',
  THIRD_PLACE:    'SF',  // 3rd-place teams are already at SF level
  FINAL:          'RU',  // default for finalists; winner overridden to 'W' below
};

const STAGE_ORDER = { group: 0, R32: 1, R16: 2, QF: 3, SF: 4, RU: 5, W: 6 };

function higherStage(a, b) {
  return (STAGE_ORDER[a] || 0) >= (STAGE_ORDER[b] || 0) ? a : b;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, body: '' };
  }

  const KEY = process.env.FOOTBALL_API_KEY;
  if (!KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'FOOTBALL_API_KEY not configured' }),
    };
  }

  const headers = { 'X-Auth-Token': KEY };

  try {
    const [matchesRes, standingsRes, scorersRes] = await Promise.all([
      fetch(`${API_BASE}/competitions/WC/matches`, { headers }),
      fetch(`${API_BASE}/competitions/WC/standings`, { headers }),
      fetch(`${API_BASE}/competitions/WC/scorers?limit=20`, { headers }),
    ]);

    if (!matchesRes.ok) {
      const txt = await matchesRes.text();
      return { statusCode: matchesRes.status, body: JSON.stringify({ error: txt }) };
    }

    const matchesData    = await matchesRes.json();
    const standingsData  = standingsRes.ok ? await standingsRes.json() : { standings: [] };
    const scorersData    = scorersRes.ok ? await scorersRes.json() : { scorers: [] };

    // Top scorers (Golden Boot). Free tier returns ~top 10.
    const scorers = (scorersData.scorers || []).map(s => ({
      name:  s.player?.name || 'Unknown',
      code:  mapTla(s.team?.tla, s.team?.name) || null,
      goals: s.goals ?? 0,
    }));

    // ── Group standings ────────────────────────────────────────────────────────
    const standings = [];
    for (const group of (standingsData.standings || [])) {
      if (group.type !== 'TOTAL') continue;
      for (const row of group.table) {
        standings.push({
          code: mapTla(row.team.tla, row.team.name),
          pos:  row.position,
          W:    row.won,
          D:    row.draw,
          L:    row.lost,
          gf:   row.goalsFor,
          ga:   row.goalsAgainst,
          // Top 2 guaranteed; best 8 3rd-place also qualify but we'll flag those
          // via knockout stage tracking below instead.
          q:    row.position <= 2 ? 'Q' : null,
        });
      }
    }

    // ── Match fixtures & knockout stage tracking ───────────────────────────────
    const fixtures  = [];
    const upcoming  = []; // future matches (TIMED/SCHEDULED) for the "Upcoming" section
    const stagesMap = {}; // tla → highest stage reached

    const allMatches = (matchesData.matches || [])
      .slice()
      .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

    for (const m of allMatches) {
      const homeTla = mapTla(m.homeTeam?.tla, m.homeTeam?.name);
      const awayTla = mapTla(m.awayTeam?.tla, m.awayTeam?.name);
      if (!homeTla || !awayTla) continue;

      const ft = m.score?.fullTime;

      // Future match → collect for the "Upcoming" section (raw ISO date so the
      // client can render kickoff in the viewer's local time). Knockout matches
      // with TBD teams were already skipped by the !homeTla/!awayTla guard.
      if (m.status === 'TIMED' || m.status === 'SCHEDULED') {
        const label = m.stage === 'GROUP_STAGE'
          ? (m.group || '').replace('GROUP_', '')
          : (m.stage === 'FINAL' ? 'F' : m.stage === 'THIRD_PLACE' ? '3P' : (STAGE_CODE[m.stage] || m.stage));
        upcoming.push({ h: homeTla, a: awayTla, g: label, utc: m.utcDate });
        continue;
      }

      if (m.stage === 'GROUP_STAGE') {
        if (m.status === 'FINISHED' && ft) {
          const grpLetter = (m.group || '').replace('GROUP_', '');
          fixtures.push([homeTla, awayTla, ft.home ?? 0, ft.away ?? 0, grpLetter, formatDate(m.utcDate)]);
        } else if (m.status === 'IN_PLAY' && ft) {
          const grpLetter = (m.group || '').replace('GROUP_', '');
          fixtures.push([homeTla, awayTla, ft.home ?? 0, ft.away ?? 0, grpLetter, formatDate(m.utcDate), 'LIVE']);
        }
      } else {
        // Knockout match
        const stageCode = STAGE_CODE[m.stage] || 'R32';

        if (m.status === 'FINISHED' && ft) {
          const homeWon = ft.home > ft.away;
          const winnerTla = homeWon ? homeTla : awayTla;
          const loserTla  = homeWon ? awayTla : homeTla;

          // Loser's stage is finalised at this round
          stagesMap[loserTla] = higherStage(stageCode, stagesMap[loserTla] || 'group');

          // Winner: if it's the FINAL they get 'W', otherwise updated in next round
          if (m.stage === 'FINAL') {
            stagesMap[winnerTla] = 'W';
          } else if (m.stage !== 'THIRD_PLACE') {
            // Winner's stage will be set when they lose in a later round (or win the final).
            // For now, ensure they're at least credited for this round:
            stagesMap[winnerTla] = higherStage(stageCode, stagesMap[winnerTla] || 'group');
          }

          // Add to fixture list for display
          const stageLabel = m.stage === 'FINAL' ? 'F' : stageCode;
          fixtures.push([homeTla, awayTla, ft.home, ft.away, stageLabel, formatDate(m.utcDate)]);

        } else if (m.status === 'IN_PLAY' && ft) {
          const stageLabel = m.stage === 'FINAL' ? 'F' : stageCode;
          fixtures.push([homeTla, awayTla, ft.home ?? 0, ft.away ?? 0, stageLabel, formatDate(m.utcDate), 'LIVE']);
        }
      }
    }

    const stages = Object.entries(stagesMap).map(([code, stage]) => ({ code, stage }));

    // ── Tournament-wide goals/clean-sheets (group + knockout combined) ─────────
    // `standings` only covers the group table, so it undercounts goals/clean
    // sheets once knockout matches start. This walks every finished/in-play
    // match instead, regardless of stage.
    const totalsMap = {}; // tla → { goalsAll, cleanSheets }
    const bump = (code) => (totalsMap[code] = totalsMap[code] || { goalsAll: 0, cleanSheets: 0 });
    for (const m of allMatches) {
      if (m.status !== 'FINISHED' && m.status !== 'IN_PLAY') continue;
      const ft = m.score?.fullTime;
      if (!ft) continue;
      const homeTla = mapTla(m.homeTeam?.tla, m.homeTeam?.name);
      const awayTla = mapTla(m.awayTeam?.tla, m.awayTeam?.name);
      if (!homeTla || !awayTla) continue;
      const hs = ft.home ?? 0, as = ft.away ?? 0;
      bump(homeTla).goalsAll += hs;
      bump(awayTla).goalsAll += as;
      if (as === 0) bump(homeTla).cleanSheets += 1;
      if (hs === 0) bump(awayTla).cleanSheets += 1;
    }
    const teamTotals = totalsMap;

    // ── Knockout bracket ───────────────────────────────────────────────────────
    // Includes every knockout tie, even those with TBD teams (null) so the
    // bracket renders its structure now and fills in after the group stage.
    const bracket = [];
    for (const m of allMatches) {
      if (m.stage === 'GROUP_STAGE') continue;
      const stage = m.stage === 'FINAL'       ? 'F'
                  : m.stage === 'THIRD_PLACE'  ? '3P'
                  : (STAGE_CODE[m.stage] || m.stage);
      const ft = m.score?.fullTime;
      const finished = m.status === 'FINISHED';
      const sw = m.score?.winner; // resolves ET/penalties for us
      bracket.push({
        stage,
        h: mapTla(m.homeTeam?.tla, m.homeTeam?.name) || null,
        a: mapTla(m.awayTeam?.tla, m.awayTeam?.name) || null,
        hs: finished ? (ft?.home ?? null) : null,
        as: finished ? (ft?.away ?? null) : null,
        status: m.status,
        utc: m.utcDate,
        winner: sw === 'HOME_TEAM' ? 'h' : sw === 'AWAY_TEAM' ? 'a' : null,
      });
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // CDN caches for 30 s — all users share one API call per 30 s window
        'Cache-Control': 's-maxage=30, max-age=30',
      },
      body: JSON.stringify({ standings, fixtures, stages, upcoming: upcoming.slice(0, 16), bracket, scorers, teamTotals }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
