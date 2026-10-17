// Wiki: one page per discipline (general, cycling, running, hiking).
// Content documents what the app actually computes, per sport scope.

const DISCIPLINES = [
  { id: '', label: 'General', icon: '🌐' },
  { id: 'cycling', label: 'Cycling', icon: '🚴' },
  { id: 'running', label: 'Running', icon: '🏃' },
  { id: 'hiking', label: 'Hiking', icon: '🥾' },
];

export async function renderWiki(scope) {
  const app = document.getElementById('app');
  const active = DISCIPLINES.some(d => d.id === scope) ? scope : '';

  app.innerHTML = `
    <div id="wiki-view" class="mx-auto" style="max-width: 860px;">
      <h4 class="mb-3">Wiki</h4>
      <ul class="nav nav-pills mb-3 flex-wrap gap-1">
        ${DISCIPLINES.map(d => `
          <li class="nav-item">
            <a class="nav-link ${d.id === active ? 'active' : ''}" href="#wiki${d.id ? '/' + d.id : ''}">${d.icon} ${d.label}</a>
          </li>`).join('')}
      </ul>
      ${active === '' ? generalWiki() : ''}
      ${active === 'cycling' ? cyclingWiki() : ''}
      ${active === 'running' ? runningWiki() : ''}
      ${active === 'hiking' ? hikingWiki() : ''}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// General: concepts shared by every sport page.
// ---------------------------------------------------------------------------
function generalWiki() {
  return `
    <div class="card mb-3">
      <div class="card-header fw-semibold">Where the data comes from</div>
      <div class="card-body">
        <p>Activities are synced from <strong>Garmin Connect</strong> via <a href="https://github.com/tngo/garmindb" target="_blank" rel="noopener">GarminDB</a>: rides, runs and hikes land in a local SQLite database together with their FIT recordings (distance, altitude, GPS, heart rate, speed, cadence, power, temperature — whatever your device records).</p>
        <ul>
          <li><strong>⬇ Fetch new activities</strong> downloads the latest activities and re-runs the analysis on whatever is new. The first setup only grabs the 1000 most recent; <strong>Parameters → Download history</strong> can scan Garmin Connect and fetch the rest in chunks.</li>
          <li><strong>📊 Analyze activities</strong> re-runs detection over everything already in the database, without touching Garmin.</li>
          <li>Activities you delete in the app stay deleted: deletions are remembered locally, so a later sync cannot resurrect them.</li>
        </ul>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Statistics page</div>
      <div class="card-body">
        <p>The Statistics page works per sport (chips at the top) or across all of them, and always over a selectable period (month, year, all…).</p>
        <ul>
          <li><strong>Streaks</strong> — current and longest weekly streaks, plus the share of active weeks.</li>
          <li><strong>Fitness &amp; freshness</strong> — the classic model: CTL (42-day EMA of training load = fitness), ATL (7-day EMA = fatigue) and TSB = CTL − ATL (form). Positive form = rested, negative = carrying fatigue.</li>
          <li><strong>Training load</strong> — Garmin's per-activity load values, plotted over time.</li>
          <li><strong>Normalized HR</strong> — average heart rate corrected for climb load, temperature and altitude (see the Cycling wiki), so the trend reflects fitness rather than where you rode.</li>
          <li><strong>Goals</strong> — monthly/yearly distance and elevation targets, stored locally in your browser.</li>
          <li><strong>Year-over-year</strong> — monthly totals for two selectable years side by side.</li>
        </ul>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Activity page</div>
      <div class="card-body">
        <ul>
          <li><strong>Journal</strong> — a note and photos per activity, kept on your machine (gitignored).</li>
          <li><strong>Map &amp; elevation profile</strong> — the recorded track; click the elevation chart to jump to that point on the map.</li>
          <li><strong>Graphs</strong> — speed (or pace for foot sports), heart rate, altitude, cadence, temperature, power over the whole activity.</li>
          <li><strong>Laps</strong> — recorded laps with their own averages.</li>
          <li><strong>▶ Flyover</strong> — a 3D video flyover of the activity (Esri satellite imagery + terrain). Playable in-app at various speeds, or downloadable as a video.</li>
          <li><strong>⬇ FIT</strong> — download the original FIT recording for any activity.</li>
        </ul>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Concepts used everywhere</div>
      <div class="card-body">
        <ul>
          <li><strong>Moving vs elapsed time</strong> — activity summaries show both Garmin values. Note that per-segment times (climb attempts, best efforts) are computed from record timestamps, so a pause <em>inside</em> a segment counts towards that segment's time.</li>
          <li><strong>Pace vs speed</strong> — foot sports read speed as min/km with an inverted axis (up = faster); cycling stays in km/h.</li>
          <li><strong>Sports grouping</strong> — Garmin's "walking" activities are grouped under Hiking in this app; the database is never rewritten.</li>
          <li><strong>Period selector</strong> — most cards recompute for the chosen period; caches (best efforts, climb stats) refresh automatically when new data lands.</li>
        </ul>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Cycling: climbs, difficulty, prediction, power, climbing profile.
// ---------------------------------------------------------------------------
function cyclingWiki() {
  return `
    <div class="card mb-3">
      <div class="card-header fw-semibold">Climb detection</div>
      <div class="card-body">
        <p>Climbs are detected automatically from every ride's altitude and distance records:</p>
        <ul>
          <li>Altitude is smoothed (15-point moving window) to kill barometric noise.</li>
          <li>A climb starts where the smoothed grade reaches <strong>3%</strong> — extended backwards to the true foot of the hill while the road still rises at ≥0.5%.</li>
          <li>It ends where the grade drops below <strong>1%</strong>; ramps separated by short false flats or dips (≤30 m lost, ≤500 m gap) are merged into one envelope.</li>
          <li>To count, a climb needs ≥300 m length and ≥2.5% average grade.</li>
        </ul>
        <p>Same real-world climb, done on different days, is matched into one group by geometry (start/end points within tolerance) — validated climbs win over geometric matching.</p>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Climb categories &amp; grade colors</div>
      <div class="card-body">
        <p>Categories are Strava-style, from <code>score = length(m) × avg grade(%)</code>:</p>
        <div class="table-responsive mb-3">
          <table class="table table-sm">
            <thead><tr><th>Score</th><th>Category</th></tr></thead>
            <tbody>
              <tr><td>≥ 80 000</td><td>HC</td></tr>
              <tr><td>≥ 64 000</td><td>Cat 1</td></tr>
              <tr><td>≥ 32 000</td><td>Cat 2</td></tr>
              <tr><td>≥ 16 000</td><td>Cat 3</td></tr>
              <tr><td>≥ 8 000</td><td>Cat 4</td></tr>
              <tr><td>below</td><td>Uncategorized</td></tr>
            </tbody>
          </table>
        </div>
        <p>The elevation chart on every climb page colors each bin by its average grade:</p>
        <div class="table-responsive">
          <table class="table table-sm">
            <thead><tr><th>Average grade</th><th>Color</th><th>Hex</th></tr></thead>
            <tbody>
              <tr><td>Downhill (&lt; -1%)</td><td><span class="badge" style="background:#0d6efd">blue</span></td><td><code>#0d6efd</code></td></tr>
              <tr><td>Flat (-1% to 1%)</td><td><span class="badge" style="background:#2ecc71">green</span></td><td><code>#2ecc71</code></td></tr>
              <tr><td>Low climb (1% to 3%)</td><td><span class="badge" style="background:#f7d794; color:#333">pale yellow</span></td><td><code>#f7d794</code></td></tr>
              <tr><td>Moderate (3% to 6%)</td><td><span class="badge" style="background:#ffc107; color:#333">gold</span></td><td><code>#ffc107</code></td></tr>
              <tr><td>Hard (6% to 9%)</td><td><span class="badge" style="background:#fd7e14">orange</span></td><td><code>#fd7e14</code></td></tr>
              <tr><td>Very hard (9% to 12%)</td><td><span class="badge" style="background:#dc3545">red</span></td><td><code>#dc3545</code></td></tr>
              <tr><td>Extreme (12% to 20%)</td><td><span class="badge" style="background:#6f42c1">purple</span></td><td><code>#6f42c1</code></td></tr>
              <tr><td>Brutal (&gt; 20%)</td><td><span class="badge" style="background:#000000">black</span></td><td><code>#000000</code></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Difficulty score</div>
      <div class="card-body">
        <p>Every climb gets a difficulty score that makes climbs comparable at a glance — a number that captures how steep, how long and how high a climb is in one value. It is based on the <a href="https://en.wikipedia.org/wiki/Classification_de_la_F.F.C." target="_blank" rel="noopener">FIETS index</a> developed by the Dutch cycling magazine <em>Fiets</em>.</p>

        <p class="mb-2"><strong>Formula</strong> (climb page, full score):</p>
        <p class="text-center fs-5"><code>score = H² / (D × 10) + max(0, (T − 1000) / 1000)</code></p>
        <div class="table-responsive">
          <table class="table table-sm">
            <thead><tr><th>Symbol</th><th>Meaning</th></tr></thead>
            <tbody>
              <tr><td><code>H</code></td><td>Ascent: elevation gain from the bottom to the top, in metres</td></tr>
              <tr><td><code>D</code></td><td>Length of the climb, in metres</td></tr>
              <tr><td><code>T</code></td><td>Summit altitude (highest point of the climb), in metres</td></tr>
            </tbody>
          </table>
        </div>

        <p class="mt-3 mb-2"><strong>How to read it</strong></p>
        <ul>
          <li>The squared ascent term rewards steepness: doubling the gradient of a climb roughly quadruples its score.</li>
          <li>The second term adds a bonus for climbs finishing above 1000 m — thin-air territory. A 2000 m summit adds 1 point, a 2800 m summit adds 1.8 points.</li>
          <li>On the climbs list, the score is shown without the summit bonus (the list has no per-climb summit altitude); the climb page always shows the full score, so a climb can score slightly higher on its detail page.</li>
        </ul>

        <p class="mb-2"><strong>Reference values</strong></p>
        <div class="table-responsive">
          <table class="table table-sm">
            <thead><tr><th>Climb</th><th>Score</th></tr></thead>
            <tbody>
              <tr><td>Col du Tourmalet (east side, ~19 km at 7.3%)</td><td>≈ 11.3</td></tr>
              <tr><td>Mauna Kea (Hawai'i — world's hardest)</td><td>≈ 28.9</td></tr>
              <tr><td>Small 2 km hill at 5%</td><td>≈ 0.5</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Profile difficulty (Cotacol points)</div>
      <div class="card-body">
        <p>The <strong>Profile difficulty</strong> card on each climb uses the <strong>Cotacol method</strong> — the section-based scoring system from the Belgian <em>Encyclopedia Cotacol</em> (1989), also used by Climbfinder for its difficulty points. Unlike the FIETS-based score, it looks at the <em>shape</em> of the climb, not just its totals.</p>

        <p class="mb-2"><strong>How it works</strong></p>
        <ul>
          <li>The climb is divided into fixed <strong>100 m sections</strong>. For each section the local gradient <code>s</code> (in %) is measured, and the section scores:</li>
        </ul>
        <p class="text-center fs-5"><code>dI = 0.001 · s² · dL</code></p>
        <p>with <code>dL</code> the section length. The total is the sum of all sections — the total effort to reach the top.</p>
        <ul>
          <li>Because effort grows with the <strong>square</strong> of the gradient, steep walls are punished heavily: one metre climbed at 10% scores 1.0 point, at 5% only 0.5, at 1% only 0.1.</li>
          <li>Two climbs with the same ascent and length can therefore score very differently: a steady climb scores far less than one with a steep ramp in the middle, which the FIETS-style score cannot see.</li>
          <li>Descents and flat sections score zero, so a climb with a dip in the middle only accumulates effort on the actual uphills.</li>
        </ul>

        <p class="mb-2"><strong>Reference values</strong></p>
        <div class="table-responsive">
          <table class="table table-sm">
            <thead><tr><th>Climb</th><th>Cotacol points</th></tr></thead>
            <tbody>
              <tr><td>Alpe d'Huez (13.8 km at 8.1%)</td><td>≈ 900</td></tr>
              <tr><td>Col du Tourmalet east (19.1 km at 7.3%)</td><td>≈ 1075</td></tr>
              <tr><td>Koppenberg (1.2 km at 11.6%, cobbles)</td><td>≈ 160</td></tr>
              <tr><td>Local 1 km hill at 3–4%</td><td>≈ 10</td></tr>
            </tbody>
          </table>
        </div>
        <p class="small text-muted mb-0">Our implementation resamples your GPS recording at 100 m stations and smooths altitude with a centred median, because a bike computer's barometric noise would otherwise inflate the squared-gradient sum.</p>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Climb page: attempts, per-bin analysis, prediction</div>
      <div class="card-body">
        <p>Each climb page groups every recorded attempt on that climb, <strong>newest first</strong> like the activity feed, with time, gap to your PR, VAM, estimated W/kg, average HR and speed.</p>
        <ul>
          <li><strong>Detailed analysis</strong> — the climb cut into fixed bins (200 m / 500 m / 1000 m): one dot per bin for the chosen metric (speed, HR, VAM, power, cadence, est. W/kg), with grey dots for other attempts and optional per-bin average/best across all attempts. Compare how you rode each section, attempt after attempt.</li>
          <li><strong>Performance chart</strong> — any metric over time with an optional regression line; gold/silver/bronze dots mark your three best values.</li>
        </ul>

        <p class="mb-2"><strong>Predicted climb time</strong> — how long the climb should take <em>you</em>, even for climbs you have never ridden:</p>
        <p>Your climb history is fed into a power-law model: the app takes every recorded climb occurrence (at least 30 m of ascent and 300 m long, taking between 1 minute and 2 hours) and fits the relation</p>
        <p class="text-center fs-5"><code>T = a · H<sup>b</sup> · D<sup>c</sup></code></p>
        <p>where <code>T</code> is the time, <code>H</code> the ascent and <code>D</code> the length of the climb. The fit is done in log space with three-variable linear regression, so the model learns your personal pace. When you have ridden the climb before, the card also shows the gap to your PR. The model needs at least 20 usable climbs; before that it shows a dash.</p>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Estimated power (no power meter)</div>
      <div class="card-body">
        <p>Without a power meter, power for each climb attempt is <strong>estimated from physics</strong>, the way Climbfinder does it: for every ~100 m section of the climb the required wattage is</p>
        <p class="text-center fs-6"><code>W = (F<sub>gravity</sub> + F<sub>rolling</sub> + F<sub>air</sub>) · v</code></p>
        <ul>
          <li><strong>Gravity</strong> uses your total mass (rider weight from your Garmin profile + ~10 kg bike) and the section gradient from the altitude profile.</li>
          <li><strong>Rolling resistance</strong> assumes asphalt (Crr 0.005); <strong>air drag</strong> assumes a hoods position (CdA 0.32 m²) with air density adjusted for altitude; ~2.5% drivetrain loss.</li>
          <li>Flat and downhill sections are skipped (no braking or wind model), and the result is the time-weighted average over the climbing sections only.</li>
        </ul>
        <p>The climb page shows <strong>Best power (est.)</strong> (W and W/kg), a <strong>Power (est.)</strong> column in the attempt table, and a Power option in the performance history chart. When a ride has real power-meter data it is used instead.</p>
        <p class="small text-muted mb-0">Accuracy is ±10–20% on steady climbs (steeper = better, gravity dominates). It does not know about wind, drafting, road surface or braking. It needs your weight in the Garmin profile; without it the estimate is skipped.</p>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Climbing profile (VAM curve)</div>
      <div class="card-body">
        <p>On the statistics page, the <strong>climbing profile</strong> chart shows how hard you can climb depending on how long the effort lasts — the climbing equivalent of a power-duration curve, like the power profile Climbfinder builds for riders.</p>

        <p class="mb-2"><strong>How it works</strong></p>
        <ul>
          <li>Every dot is one climb you have recorded (≥50 m ascent, ≥2 min): its duration on the x-axis (log scale, with alternating shaded <strong>duration bands</strong>), and your <strong>VAM</strong> — vertical metres gained per hour — on the y-axis. VAM is the standard measure of climbing speed: it captures how fast you gain altitude regardless of the road's gradient.</li>
          <li>Climbs are grouped into duration bands (2–5 min, 5–10, 10–20, 20–40, 40–90, 90+ min). In each band the 90th-percentile VAM is kept — a robust best effort, immune to one freak climb — and these define your <em>envelope</em>: what you can do on a good day.</li>
          <li>The red <strong>envelope curve</strong> fits those points with <code>VAM = V₀ + K / T<sup>b</sup></code>, the same shape as the critical-power model used for wattage curves. The floor <code>V₀</code> is your <strong>sustainable VAM</strong> — the vertical speed you could theoretically hold for hours; the bigger <code>K</code> is, the more extra punch you have on short efforts.</li>
          <li>The grey dashed <strong>steady-pace floor</strong> is the same fit on the 25th percentile per band: your typical everyday climbing speed. Together the two curves complete the picture — your rides live between "what you can do" and "what you normally do".</li>
          <li>The dashed <strong>recent form</strong> curve fits only the most recent third of your history and compares it with your early years: green means your sustainable VAM improved, amber means it dropped.</li>
        </ul>

        <p class="mb-2"><strong>Reading it</strong></p>
        <ul>
          <li>Top-left corner = your anaerobic punch (short, steep bursts). The flat right side = your aerobic engine (long cols).</li>
          <li>Most blue dots sit <em>between</em> the two curves — that is normal: the envelope only tracks best efforts, the floor your easy days.</li>
          <li>A flatter envelope over time means better endurance; a higher left side means better short-climb punch. Use the period buttons above the chart to compare.</li>
        </ul>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Normalized HR (fitness trend)</div>
      <div class="card-body">
        <p>Raw average heart rate per ride is hard to compare: a ride up a big climb, in heat or at altitude naturally runs higher than a flat commute, so a simple HR-over-time chart mostly reflects <em>where and when</em> you rode, not how your fitness evolved. The <strong>Normalized HR</strong> chart fixes this the way Strava does for graded runs:</p>
        <ul>
          <li>The app fits a linear model over your rides: <code>HR = intercept + b₁·climb intensity + b₂·temperature + b₃·altitude</code>, where climb intensity is vertical metres per km and temperature its deviation from 20°C.</li>
          <li>Each ride's heart rate is then <strong>corrected</strong>: the fitted effects are subtracted, so every ride is shown as if done under your <em>typical</em> conditions.</li>
          <li>The chart plots one dot per ride, a <strong>90-day moving average</strong> as the trend line, and your raw average HR (grey) for comparison. When the green line drifts down while the grey line jumps around, fitness improved: the same typical ride now costs fewer beats.</li>
        </ul>
        <p class="small text-muted mb-0">The fit quality (R², residual error) and the removed effects are printed under the chart. With many mixed rides the fit is noisy — treat the moving average, not individual dots, as the signal.</p>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Weather correlation</div>
      <div class="card-body">
        <p>One dot per ride: a performance metric (speed, or efficiency = speed/HR) against conditions (temperature, altitude, or the two multiplied). An optional regression line with R² tells you how much the weather actually matters to your pace. Temperature is read from the ride's own recordings (plausible −20…45 °C only).</p>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Explore &amp; curated cols</div>
      <div class="card-body">
        <p><strong>Explore climbs</strong> lists famous cols from a curated database (name, region, summit point). Geometry is enriched from OpenStreetMap on demand, and "climbed" status is matched against your own history by proximity of the col point to any ridden track. Filter by country, region or status; switch between list and map views.</p>
        <p>Climb names on your own rides are suggested from OpenStreetMap (named roads and features near the climb), and you can rename or validate any climb — validated climbs become the canonical named segment that every future attempt is matched against. Segment edits and curated lists can be imported from another installation via <strong>Parameters</strong>.</p>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Cycling VO₂ max estimate</div>
      <div class="card-body">
        <p>Without a power meter, watts come from the climb-physics model on your steepest 3–12 min climb efforts, converted to VO₂max via the ACSM leg-ergometry equation, adjusted for how close to VO₂max an effort of that duration can be ridden. Constants (CdA, mass) carry ±10–15% uncertainty — read it as a range, not a lab number. Garmin's own estimate is plotted alongside for comparison.</p>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Running: pace, best efforts, VDOT, HR-pace.
// ---------------------------------------------------------------------------
function runningWiki() {
  return `
    <div class="card mb-3">
      <div class="card-header fw-semibold">Pace everywhere</div>
      <div class="card-body">
        <p>Speed is always displayed as <strong>pace (min/km)</strong> for running — activity summaries, laps, graphs (inverted axis so up = faster), and the best-efforts table. Efficiency metrics are expressed as <em>pace / HR</em>: the lower, the more distance you get per beat.</p>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Best efforts</div>
      <div class="card-body">
        <p>For each run, the app keeps your fastest time covering the standard distances: <strong>1K, 1 mile, 5K, 10K, half marathon, marathon</strong>. These are rolling windows over the recorded distance and timestamps — no laps needed, pauses inside a window simply cost time. The Statistics page shows your best per distance for the selected period, with the run it was set on.</p>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">VO₂ max estimate (VDOT)</div>
      <div class="card-body">
        <p>Your running VO₂ max is estimated with Jack Daniels' <strong>VDOT</strong> approach: each best-effort pace is converted to the metabolic cost of running at that speed (ACSM equation), then divided by the fraction of VO₂max sustainable for that duration (Daniels tables — shorter races are supramaximal, longer ones drain towards the sustainable rate). The median across distances gives one number per period. Garmin's own estimate from the watch is plotted alongside for comparison.</p>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Heart rate vs pace — aerobic cost</div>
      <div class="card-body">
        <p>A scatter of your runs (running statistics only): average pace on one axis, average HR on the other, color-coded by year, with an optional least-squares regression line per year.</p>
        <ul>
          <li>A year's line sitting <em>below</em> a previous year's means you run the same pace at a lower heart rate — aerobic improvement.</li>
          <li>Runs slower than 12 min/km (walk breaks, GPS pauses) are excluded from the regression; at least 5 runs are needed for the chart.</li>
        </ul>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">Training load &amp; streaks</div>
      <div class="card-body">
        <p>Running shares the general training analysis: fitness/freshness (CTL/ATL/TSB), Garmin training load, streaks and goals — computed on running activities only on this page, or across all sports under "All". See the General wiki for how these work.</p>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Hiking: grouping, pace, what's intentionally absent.
// ---------------------------------------------------------------------------
function hikingWiki() {
  return `
    <div class="card mb-3">
      <div class="card-header fw-semibold">Hiking &amp; walking</div>
      <div class="card-body">
        <p>Garmin records both <code>hiking</code> and <code>walking</code> activities; this app groups them under a single <strong>Hiking</strong> sport. The database is never rewritten — the grouping happens at display and analysis time.</p>
        <ul>
          <li>Speed reads as <strong>pace (min/km)</strong>, like running.</li>
          <li>Activity pages, maps, elevation profiles, journals, flyovers and photos work exactly as for any other sport.</li>
          <li>Statistics cover distance, elevation, streaks, fitness/freshness, training load and goals.</li>
        </ul>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header fw-semibold">What's intentionally absent</div>
      <div class="card-body">
        <p>Stride-dependent metrics do not translate to foot travel at hiking speeds, so the app skips:</p>
        <ul>
          <li><strong>Climb detection</strong> — Strava categories, VAM and W/kg are cycling concepts; a hike is already "the climb".</li>
          <li><strong>Best-effort distances</strong> — no fixed distance set for hiking; pace varies too much between ascents and descents for the numbers to mean anything.</li>
          <li><strong>VO₂ max estimate</strong> — the VDOT and cycling-physics models both assume steady aerobic motion; they are not computed for hiking (Garmin's own estimate is still shown on its page if your watch recorded one).</li>
          <li><strong>Weather correlation</strong> — a hiking "efficiency" number would mostly reflect terrain, not weather.</li>
        </ul>
        <p class="small text-muted mb-0">Your history is never lost: enable any sport in Parameters and its analysis appears with the next sync.</p>
      </div>
    </div>
  `;
}
