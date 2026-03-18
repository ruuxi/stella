/**
 * Stella Interactive Rendering Performance Profiler
 *
 * Measures post-load rendering performance using CDP (Chrome DevTools Protocol)
 * via Playwright. Focuses on what happens AFTER the page loads.
 */

import { chromium } from 'playwright';

const APP_URL = 'http://localhost:5714';
const SETTLE_TIME = 5000; // 5 seconds for app to settle
const PROFILE_DURATION = 5000; // 5 second CPU profile

async function run() {
  console.log('='.repeat(80));
  console.log('STELLA INTERACTIVE RENDERING PERFORMANCE PROFILE');
  console.log('='.repeat(80));
  console.log(`Target: ${APP_URL}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-gpu',
      '--no-sandbox',
      '--disable-extensions',
      '--enable-precise-memory-info',
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();
  const client = await page.context().newCDPSession(page);

  // ─── Collect network requests ───
  const networkRequests = [];
  page.on('request', req => {
    networkRequests.push({
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      startTime: Date.now(),
    });
  });
  page.on('response', resp => {
    const entry = networkRequests.find(r => r.url === resp.url() && !r.status);
    if (entry) {
      entry.status = resp.status();
      entry.endTime = Date.now();
      entry.duration = entry.endTime - entry.startTime;
    }
  });

  // ─── STEP 1: Navigate and wait for full load ───
  console.log('[1/8] Navigating to app and waiting for full load...');
  const navStart = Date.now();

  try {
    await page.goto(APP_URL, { waitUntil: 'load', timeout: 30000 });
  } catch (e) {
    console.error(`FATAL: Could not reach ${APP_URL}. Is the dev server running? (bun run dev)`);
    console.error(e.message);
    await browser.close();
    process.exit(1);
  }

  const loadTime = Date.now() - navStart;
  console.log(`  Page load complete in ${loadTime}ms`);

  // Wait for network idle (no requests for 500ms)
  await page.waitForLoadState('networkidle').catch(() => {});
  const networkIdleTime = Date.now() - navStart;
  console.log(`  Network idle at ${networkIdleTime}ms`);
  console.log('');

  // ─── STEP 2: Enable CDP domains and start tracing ───
  console.log('[2/8] Starting CDP Performance trace + Profiler...');

  // Enable Performance domain
  await client.send('Performance.enable', { timeDomain: 'timeTicks' });

  // Enable profiler
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 100 }); // 100 microseconds

  // Start precise tracing
  await client.send('Tracing.start', {
    categories: [
      'devtools.timeline',
      'v8.execute',
      'blink.user_timing',
      'blink.console',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'disabled-by-default-v8.cpu_profiler',
      'disabled-by-default-devtools.timeline.stack',
      'loading',
      'painting',
      'rendering',
    ].join(','),
    options: 'sampling-frequency=10000',
  });

  // Start CPU profiler
  await client.send('Profiler.start');

  // Inject performance observers into the page BEFORE the settle period
  await page.evaluate(() => {
    // Track layout shifts
    window.__perfData = {
      layoutShifts: [],
      longTasks: [],
      paints: [],
      measures: [],
      marks: [],
      frameCount: 0,
      frameTimes: [],
      lastFrameTime: performance.now(),
      reactRenders: 0,
      reactCommits: [],
    };

    // Long Task observer
    if (window.PerformanceObserver) {
      try {
        const longTaskObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__perfData.longTasks.push({
              name: entry.name,
              startTime: entry.startTime,
              duration: entry.duration,
            });
          }
        });
        longTaskObs.observe({ type: 'longtask', buffered: true });
      } catch (e) {}

      // Layout shift observer
      try {
        const layoutObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__perfData.layoutShifts.push({
              value: entry.value,
              startTime: entry.startTime,
              hadRecentInput: entry.hadRecentInput,
            });
          }
        });
        layoutObs.observe({ type: 'layout-shift', buffered: true });
      } catch (e) {}

      // Paint observer
      try {
        const paintObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__perfData.paints.push({
              name: entry.name,
              startTime: entry.startTime,
            });
          }
        });
        paintObs.observe({ type: 'paint', buffered: true });
      } catch (e) {}
    }

    // Frame counter via rAF
    let frameId;
    function countFrames() {
      const now = performance.now();
      window.__perfData.frameCount++;
      window.__perfData.frameTimes.push(now - window.__perfData.lastFrameTime);
      window.__perfData.lastFrameTime = now;
      frameId = requestAnimationFrame(countFrames);
    }
    frameId = requestAnimationFrame(countFrames);
    window.__stopFrameCounter = () => cancelAnimationFrame(frameId);

    // Hook into React DevTools if available
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
      const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      const originalOnCommitFiberRoot = hook.onCommitFiberRoot;
      if (originalOnCommitFiberRoot) {
        hook.onCommitFiberRoot = function (...args) {
          window.__perfData.reactRenders++;
          const commitTime = performance.now();
          window.__perfData.reactCommits.push({ time: commitTime });
          return originalOnCommitFiberRoot.apply(this, args);
        };
      }
    }
  });

  // ─── STEP 3: Wait for app to settle ───
  console.log(`[3/8] Waiting ${SETTLE_TIME / 1000}s for app to settle (React renders, data fetching, animations)...`);
  await new Promise(r => setTimeout(r, SETTLE_TIME));
  console.log('  Settle period complete.');
  console.log('');

  // ─── STEP 4: Stop tracing and profiling ───
  console.log('[4/8] Stopping CDP trace and profiler...');

  // Stop CPU profiler
  const cpuProfile = await client.send('Profiler.stop');

  // Stop frame counter
  await page.evaluate(() => window.__stopFrameCounter && window.__stopFrameCounter());

  // Collect trace events
  const traceEvents = [];
  client.on('Tracing.dataCollected', (data) => {
    traceEvents.push(...data.value);
  });

  await new Promise((resolve) => {
    client.on('Tracing.tracingComplete', resolve);
    client.send('Tracing.end');
  });

  // Get performance metrics
  const { metrics: perfMetrics } = await client.send('Performance.getMetrics');

  console.log(`  Collected ${traceEvents.length} trace events`);
  console.log(`  CPU profile has ${cpuProfile.profile.nodes?.length || 0} nodes`);
  console.log('');

  // ─── STEP 5: Collect in-page performance data ───
  console.log('[5/8] Collecting in-page performance data...');

  const inPageData = await page.evaluate(() => {
    const data = window.__perfData || {};

    // Gather performance entries
    const marks = performance.getEntriesByType('mark').map(e => ({
      name: e.name,
      startTime: e.startTime,
    }));

    const measures = performance.getEntriesByType('measure').map(e => ({
      name: e.name,
      startTime: e.startTime,
      duration: e.duration,
    }));

    const resources = performance.getEntriesByType('resource').map(e => ({
      name: e.name,
      initiatorType: e.initiatorType,
      startTime: e.startTime,
      duration: e.duration,
      transferSize: e.transferSize,
      decodedBodySize: e.decodedBodySize,
    }));

    const navigation = performance.getEntriesByType('navigation')[0];
    const navTiming = navigation ? {
      domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
      loadEventEnd: navigation.loadEventEnd,
      domInteractive: navigation.domInteractive,
      domComplete: navigation.domComplete,
      responseEnd: navigation.responseEnd,
      duration: navigation.duration,
    } : null;

    return {
      marks,
      measures,
      resources,
      navTiming,
      longTasks: data.longTasks || [],
      layoutShifts: data.layoutShifts || [],
      paints: data.paints || [],
      frameCount: data.frameCount || 0,
      frameTimes: data.frameTimes || [],
      reactRenders: data.reactRenders || 0,
      reactCommits: data.reactCommits || [],
    };
  });

  console.log('  Collected in-page data.');
  console.log('');

  // ─── STEP 6: Analyze trace events ───
  console.log('[6/8] Analyzing trace events...');

  // Categorize trace events
  const eventsByCategory = {};
  const jsExecutionEvents = [];
  const layoutEvents = [];
  const paintEvents = [];
  const recalcStyleEvents = [];
  const functionCallEvents = [];
  const timerEvents = [];
  const gcEvents = [];
  const commitEvents = [];

  for (const event of traceEvents) {
    // Count by category
    const cat = event.cat || 'unknown';
    eventsByCategory[cat] = (eventsByCategory[cat] || 0) + 1;

    const name = event.name;
    const dur = event.dur || 0; // microseconds

    if (event.ph === 'X' || event.ph === 'B') { // Complete or Begin events
      if (name === 'EvaluateScript' || name === 'v8.compile' || name === 'FunctionCall' || name === 'V8.Execute') {
        jsExecutionEvents.push({ name, dur, args: event.args, ts: event.ts });
      }
      if (name === 'FunctionCall') {
        functionCallEvents.push({
          dur,
          url: event.args?.data?.url || '',
          functionName: event.args?.data?.functionName || '',
          scriptId: event.args?.data?.scriptId || '',
          lineNumber: event.args?.data?.lineNumber || 0,
          columnNumber: event.args?.data?.columnNumber || 0,
          ts: event.ts,
        });
      }
      if (name === 'Layout') {
        layoutEvents.push({ dur, ts: event.ts, args: event.args });
      }
      if (name === 'Paint' || name === 'PaintImage' || name === 'CompositeLayers' || name === 'RasterTask') {
        paintEvents.push({ name, dur, ts: event.ts });
      }
      if (name === 'UpdateLayoutTree' || name === 'RecalculateStyles') {
        recalcStyleEvents.push({ name, dur, ts: event.ts });
      }
      if (name === 'TimerFire' || name === 'TimerInstall') {
        timerEvents.push({ name, dur, ts: event.ts, args: event.args });
      }
      if (name === 'MajorGC' || name === 'MinorGC' || name === 'V8.GCScavenger' || name === 'V8.GCCompactor' || name === 'BlinkGC.AtomicPhase') {
        gcEvents.push({ name, dur, ts: event.ts });
      }
      if (name === 'Commit' || name === 'CompositeLayers') {
        commitEvents.push({ name, dur, ts: event.ts });
      }
    }
  }

  // ─── STEP 7: Analyze CPU profile ───
  console.log('[7/8] Analyzing CPU profile for top functions...');

  const profile = cpuProfile.profile;
  const nodes = profile.nodes || [];
  const samples = profile.samples || [];
  const timeDeltas = profile.timeDeltas || [];

  // Build node map
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.id, {
      id: node.id,
      callFrame: node.callFrame,
      hitCount: node.hitCount || 0,
      children: node.children || [],
      selfTime: 0,
      totalTime: 0,
    });
  }

  // Calculate self time from samples
  let totalProfileTime = 0;
  for (let i = 0; i < samples.length; i++) {
    const nodeId = samples[i];
    const delta = timeDeltas[i] || 0;
    totalProfileTime += delta;
    const node = nodeMap.get(nodeId);
    if (node) {
      node.selfTime += delta;
    }
  }

  // Get top functions by self time
  const allNodes = Array.from(nodeMap.values())
    .filter(n => n.selfTime > 0 && n.callFrame.functionName)
    .sort((a, b) => b.selfTime - a.selfTime);

  const top20Functions = allNodes.slice(0, 20);

  // ─── STEP 8: Generate Report ───
  console.log('[8/8] Generating report...');
  console.log('');

  // ══════════════════════════════════════════════════════════════════
  // REPORT
  // ══════════════════════════════════════════════════════════════════

  console.log('='.repeat(80));
  console.log('PERFORMANCE ANALYSIS REPORT');
  console.log('='.repeat(80));

  // ─── A) React Render Profiling ───
  console.log('\n' + '─'.repeat(80));
  console.log('A) REACT RENDER PROFILING');
  console.log('─'.repeat(80));
  console.log(`  Total React commits/renders detected: ${inPageData.reactRenders}`);
  if (inPageData.reactCommits.length > 0) {
    const commitTimes = inPageData.reactCommits.map(c => c.time);
    const firstCommit = Math.min(...commitTimes);
    const lastCommit = Math.max(...commitTimes);
    console.log(`  First commit at: ${firstCommit.toFixed(1)}ms`);
    console.log(`  Last commit at:  ${lastCommit.toFixed(1)}ms`);
    console.log(`  Commit span:     ${(lastCommit - firstCommit).toFixed(1)}ms`);

    // Commits per second
    if (lastCommit > firstCommit) {
      const cps = (inPageData.reactRenders / ((lastCommit - firstCommit) / 1000)).toFixed(1);
      console.log(`  Commits/second:  ${cps}`);
    }

    // Show commit timeline (buckets of 500ms)
    console.log('\n  React commit timeline (per 500ms bucket):');
    const bucketSize = 500;
    const buckets = {};
    for (const ct of commitTimes) {
      const bucket = Math.floor(ct / bucketSize) * bucketSize;
      buckets[bucket] = (buckets[bucket] || 0) + 1;
    }
    const sortedBuckets = Object.entries(buckets).sort((a, b) => Number(a[0]) - Number(b[0]));
    for (const [time, count] of sortedBuckets) {
      const bar = '#'.repeat(Math.min(count, 60));
      console.log(`    ${Number(time).toFixed(0).padStart(6)}ms: ${bar} (${count})`);
    }
  }

  // Long tasks during settle (likely React renders blocking main thread)
  console.log(`\n  Long Tasks (>50ms, blocking main thread): ${inPageData.longTasks.length}`);
  if (inPageData.longTasks.length > 0) {
    const sorted = [...inPageData.longTasks].sort((a, b) => b.duration - a.duration);
    for (const lt of sorted.slice(0, 15)) {
      console.log(`    at ${lt.startTime.toFixed(0).padStart(6)}ms — duration: ${lt.duration.toFixed(1)}ms [${lt.name}]`);
    }
    const totalBlocked = sorted.reduce((s, t) => s + t.duration, 0);
    console.log(`  Total main-thread blocking time: ${totalBlocked.toFixed(1)}ms`);
  }

  // ─── B) JavaScript Execution Breakdown ───
  console.log('\n' + '─'.repeat(80));
  console.log('B) JAVASCRIPT EXECUTION BREAKDOWN');
  console.log('─'.repeat(80));

  const totalJsTimeUs = jsExecutionEvents.reduce((s, e) => s + e.dur, 0);
  const totalJsTimeMs = totalJsTimeUs / 1000;
  console.log(`  Total JS execution time (trace): ${totalJsTimeMs.toFixed(1)}ms`);
  console.log(`  Number of JS execution events:   ${jsExecutionEvents.length}`);

  // JS by event type
  const jsByType = {};
  for (const e of jsExecutionEvents) {
    jsByType[e.name] = (jsByType[e.name] || 0) + e.dur;
  }
  console.log('\n  JS time by event type:');
  for (const [name, dur] of Object.entries(jsByType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${name.padEnd(25)} ${(dur / 1000).toFixed(1)}ms`);
  }

  // Top function calls from trace
  const topFnCalls = functionCallEvents
    .filter(f => f.dur > 0)
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 15);

  if (topFnCalls.length > 0) {
    console.log('\n  Top 15 longest FunctionCall events from trace:');
    for (const fn of topFnCalls) {
      const urlShort = fn.url ? fn.url.split('/').slice(-2).join('/') : '(anonymous)';
      console.log(`    ${(fn.dur / 1000).toFixed(1).padStart(8)}ms — ${fn.functionName || '(anonymous)'} @ ${urlShort}:${fn.lineNumber}`);
    }
  }

  // Timer analysis
  const timerFires = timerEvents.filter(t => t.name === 'TimerFire');
  console.log(`\n  Timer fires during profile:  ${timerFires.length}`);
  if (timerFires.length > 0) {
    const totalTimerTime = timerFires.reduce((s, t) => s + t.dur, 0) / 1000;
    console.log(`  Total timer execution time:  ${totalTimerTime.toFixed(1)}ms`);
  }

  // GC events
  console.log(`\n  Garbage Collection events:   ${gcEvents.length}`);
  if (gcEvents.length > 0) {
    const totalGcTime = gcEvents.reduce((s, e) => s + e.dur, 0) / 1000;
    console.log(`  Total GC time:               ${totalGcTime.toFixed(1)}ms`);
    for (const gc of gcEvents.sort((a, b) => b.dur - a.dur).slice(0, 5)) {
      console.log(`    ${gc.name.padEnd(25)} ${(gc.dur / 1000).toFixed(2)}ms`);
    }
  }

  // ─── C) Layout/Paint Metrics ───
  console.log('\n' + '─'.repeat(80));
  console.log('C) LAYOUT / PAINT METRICS');
  console.log('─'.repeat(80));

  console.log(`  Layout recalculations:       ${layoutEvents.length}`);
  if (layoutEvents.length > 0) {
    const totalLayoutTime = layoutEvents.reduce((s, e) => s + e.dur, 0) / 1000;
    console.log(`  Total layout time:           ${totalLayoutTime.toFixed(1)}ms`);
    const topLayouts = layoutEvents.sort((a, b) => b.dur - a.dur).slice(0, 5);
    console.log('  Top 5 longest layouts:');
    for (const l of topLayouts) {
      console.log(`    ${(l.dur / 1000).toFixed(2).padStart(8)}ms`);
    }
  }

  console.log(`\n  Style recalculations:        ${recalcStyleEvents.length}`);
  if (recalcStyleEvents.length > 0) {
    const totalStyleTime = recalcStyleEvents.reduce((s, e) => s + e.dur, 0) / 1000;
    console.log(`  Total style recalc time:     ${totalStyleTime.toFixed(1)}ms`);
  }

  console.log(`\n  Paint operations:            ${paintEvents.length}`);
  if (paintEvents.length > 0) {
    const totalPaintTime = paintEvents.reduce((s, e) => s + e.dur, 0) / 1000;
    console.log(`  Total paint time:            ${totalPaintTime.toFixed(1)}ms`);
    const paintByType = {};
    for (const p of paintEvents) {
      paintByType[p.name] = (paintByType[p.name] || 0) + 1;
    }
    console.log('  Paint events by type:');
    for (const [name, count] of Object.entries(paintByType).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${name.padEnd(25)} ${count}`);
    }
  }

  // Layout shifts
  console.log(`\n  Layout shifts (CLS events):  ${inPageData.layoutShifts.length}`);
  if (inPageData.layoutShifts.length > 0) {
    const totalCLS = inPageData.layoutShifts.reduce((s, e) => s + e.value, 0);
    console.log(`  Cumulative Layout Shift:     ${totalCLS.toFixed(4)}`);
    for (const ls of inPageData.layoutShifts) {
      console.log(`    at ${ls.startTime.toFixed(0).padStart(6)}ms — shift: ${ls.value.toFixed(4)} ${ls.hadRecentInput ? '(input-related)' : ''}`);
    }
  }

  // Forced reflow detection: Layout event immediately after a script
  let forcedReflows = 0;
  const sortedTraceByTs = traceEvents
    .filter(e => (e.ph === 'X' || e.ph === 'B') && (e.name === 'Layout' || e.name === 'FunctionCall' || e.name === 'EvaluateScript'))
    .sort((a, b) => a.ts - b.ts);

  for (let i = 1; i < sortedTraceByTs.length; i++) {
    if (sortedTraceByTs[i].name === 'Layout') {
      const prev = sortedTraceByTs[i - 1];
      if (prev.name === 'FunctionCall' || prev.name === 'EvaluateScript') {
        // Layout forced by script (within 1ms)
        if ((sortedTraceByTs[i].ts - (prev.ts + (prev.dur || 0))) < 1000) {
          forcedReflows++;
        }
      }
    }
  }
  console.log(`\n  Potential forced reflows:     ${forcedReflows}`);

  // ─── D) Network Waterfall for Data ───
  console.log('\n' + '─'.repeat(80));
  console.log('D) NETWORK WATERFALL (Post-Load API/Data Calls)');
  console.log('─'.repeat(80));

  // Filter to API/data calls (not static assets)
  const dataRequests = networkRequests.filter(r => {
    const url = r.url.toLowerCase();
    return (
      url.includes('/api/') ||
      url.includes('convex') ||
      r.resourceType === 'fetch' ||
      r.resourceType === 'xhr' ||
      r.resourceType === 'websocket' ||
      url.includes('.json') ||
      (r.resourceType === 'other' && !url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.svg') && !url.includes('.woff'))
    );
  });

  // Also show resources from performance API
  const fetchResources = inPageData.resources.filter(r =>
    r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest' || r.name.includes('convex')
  );

  if (dataRequests.length > 0) {
    console.log(`\n  Intercepted data requests (${dataRequests.length}):`);
    const sorted = [...dataRequests].sort((a, b) => a.startTime - b.startTime);
    for (const req of sorted) {
      const urlShort = req.url.length > 80 ? req.url.substring(0, 77) + '...' : req.url;
      console.log(`    ${req.method.padEnd(5)} ${(req.duration || '?').toString().padStart(5)}ms  [${req.status || '???'}] ${req.resourceType.padEnd(10)} ${urlShort}`);
    }
  }

  if (fetchResources.length > 0) {
    console.log(`\n  Performance API fetch/XHR resources (${fetchResources.length}):`);
    const sorted = [...fetchResources].sort((a, b) => a.startTime - b.startTime);
    for (const res of sorted) {
      const urlShort = res.name.length > 80 ? res.name.substring(0, 77) + '...' : res.name;
      console.log(`    ${res.startTime.toFixed(0).padStart(6)}ms  ${res.duration.toFixed(0).padStart(5)}ms  ${(res.transferSize / 1024).toFixed(1).padStart(6)}KB  ${urlShort}`);
    }
  }

  // Show WebSocket connections
  const wsRequests = networkRequests.filter(r => r.url.startsWith('ws://') || r.url.startsWith('wss://'));
  if (wsRequests.length > 0) {
    console.log(`\n  WebSocket connections (${wsRequests.length}):`);
    for (const ws of wsRequests) {
      console.log(`    ${ws.url}`);
    }
  }

  // All network requests summary
  console.log(`\n  Total network requests: ${networkRequests.length}`);
  const byType = {};
  for (const r of networkRequests) {
    byType[r.resourceType] = (byType[r.resourceType] || 0) + 1;
  }
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type.padEnd(15)} ${count}`);
  }

  // ─── E) Frame Rate During Initial Render ───
  console.log('\n' + '─'.repeat(80));
  console.log('E) FRAME RATE DURING SETTLE PERIOD');
  console.log('─'.repeat(80));

  const frameTimes = inPageData.frameTimes;
  if (frameTimes.length > 0) {
    const totalFrameTime = frameTimes.reduce((s, t) => s + t, 0);
    const avgFrameTime = totalFrameTime / frameTimes.length;
    const avgFps = 1000 / avgFrameTime;
    const minFrameTime = Math.min(...frameTimes);
    const maxFrameTime = Math.max(...frameTimes);

    console.log(`  Total frames:        ${frameTimes.length}`);
    console.log(`  Duration:            ${totalFrameTime.toFixed(0)}ms`);
    console.log(`  Average FPS:         ${avgFps.toFixed(1)}`);
    console.log(`  Avg frame time:      ${avgFrameTime.toFixed(1)}ms`);
    console.log(`  Min frame time:      ${minFrameTime.toFixed(1)}ms`);
    console.log(`  Max frame time:      ${maxFrameTime.toFixed(1)}ms`);

    // Dropped frames (>33ms = below 30fps)
    const droppedFrames = frameTimes.filter(t => t > 33.3);
    const jankyFrames = frameTimes.filter(t => t > 16.7); // below 60fps
    console.log(`\n  Frames below 60fps:  ${jankyFrames.length} (${(jankyFrames.length / frameTimes.length * 100).toFixed(1)}%)`);
    console.log(`  Frames below 30fps:  ${droppedFrames.length} (${(droppedFrames.length / frameTimes.length * 100).toFixed(1)}%)`);

    if (droppedFrames.length > 0) {
      console.log('  Worst frame times:');
      const worst = [...frameTimes].sort((a, b) => b - a).slice(0, 10);
      for (const ft of worst) {
        const fps = (1000 / ft).toFixed(0);
        console.log(`    ${ft.toFixed(1).padStart(8)}ms (${fps} fps)`);
      }
    }

    // FPS over time (1-second buckets)
    console.log('\n  FPS timeline (1-second buckets):');
    let elapsed = 0;
    let bucketFrames = 0;
    let bucketIdx = 0;
    for (const ft of frameTimes) {
      elapsed += ft;
      bucketFrames++;
      if (elapsed >= 1000) {
        const fps = (bucketFrames / (elapsed / 1000)).toFixed(0);
        const bar = '#'.repeat(Math.min(Math.round(Number(fps)), 120));
        console.log(`    ${bucketIdx}s-${bucketIdx + 1}s: ${fps.padStart(4)} fps ${bar}`);
        bucketIdx++;
        elapsed = 0;
        bucketFrames = 0;
      }
    }
    if (bucketFrames > 0 && elapsed > 100) {
      const fps = (bucketFrames / (elapsed / 1000)).toFixed(0);
      console.log(`    ${bucketIdx}s+:   ${fps.padStart(4)} fps`);
    }
  }

  // ─── F) Interaction Readiness ───
  console.log('\n' + '─'.repeat(80));
  console.log('F) INTERACTION READINESS');
  console.log('─'.repeat(80));

  if (inPageData.navTiming) {
    const nav = inPageData.navTiming;
    console.log(`  DOM Interactive:              ${nav.domInteractive.toFixed(0)}ms`);
    console.log(`  DOM Content Loaded End:       ${nav.domContentLoadedEventEnd.toFixed(0)}ms`);
    console.log(`  DOM Complete:                 ${nav.domComplete.toFixed(0)}ms`);
    console.log(`  Load Event End:               ${nav.loadEventEnd.toFixed(0)}ms`);
    console.log(`  Response End:                 ${nav.responseEnd.toFixed(0)}ms`);
  }

  // Paint timing
  if (inPageData.paints.length > 0) {
    console.log('\n  Paint events:');
    for (const p of inPageData.paints) {
      console.log(`    ${p.name.padEnd(30)} ${p.startTime.toFixed(0)}ms`);
    }
  }

  // Time to first React render
  if (inPageData.reactCommits.length > 0) {
    console.log(`\n  First React commit:           ${inPageData.reactCommits[0].time.toFixed(0)}ms`);
  }

  // CDP Performance metrics
  console.log('\n  CDP Performance.getMetrics:');
  const interestingMetrics = [
    'Timestamp', 'Documents', 'Frames', 'JSEventListeners',
    'Nodes', 'LayoutCount', 'RecalcStyleCount', 'LayoutDuration',
    'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration',
    'JSHeapUsedSize', 'JSHeapTotalSize', 'FirstMeaningfulPaint',
    'DomContentLoaded', 'NavigationStart',
  ];
  for (const m of perfMetrics) {
    if (interestingMetrics.includes(m.name) || m.name.includes('Duration') || m.name.includes('Count')) {
      let val = m.value;
      let suffix = '';
      if (m.name.includes('Duration')) {
        val = (val * 1000).toFixed(1);
        suffix = 'ms';
      } else if (m.name.includes('Size')) {
        val = (val / 1024 / 1024).toFixed(2);
        suffix = 'MB';
      } else if (m.name.includes('Timestamp') || m.name === 'FirstMeaningfulPaint' || m.name === 'DomContentLoaded' || m.name === 'NavigationStart') {
        // These are epoch seconds, not super useful raw
        continue;
      } else {
        val = val.toLocaleString();
      }
      console.log(`    ${m.name.padEnd(30)} ${val}${suffix}`);
    }
  }

  // ─── G) App-Level Performance Marks/Measures ───
  console.log('\n' + '─'.repeat(80));
  console.log('G) APP-LEVEL PERFORMANCE MARKS & MEASURES');
  console.log('─'.repeat(80));

  if (inPageData.marks.length > 0) {
    console.log(`\n  Performance Marks (${inPageData.marks.length}):`);
    for (const m of inPageData.marks.sort((a, b) => a.startTime - b.startTime)) {
      console.log(`    ${m.startTime.toFixed(0).padStart(6)}ms  ${m.name}`);
    }
  } else {
    console.log('  No performance.mark() entries found.');
  }

  if (inPageData.measures.length > 0) {
    console.log(`\n  Performance Measures (${inPageData.measures.length}):`);
    for (const m of inPageData.measures.sort((a, b) => b.duration - a.duration)) {
      console.log(`    ${m.startTime.toFixed(0).padStart(6)}ms  ${m.duration.toFixed(1).padStart(8)}ms  ${m.name}`);
    }
  } else {
    console.log('  No performance.measure() entries found.');
  }

  // ─── H) CPU Profile — Top 20 Heaviest Functions ───
  console.log('\n' + '─'.repeat(80));
  console.log('H) CPU PROFILE — TOP 20 HEAVIEST FUNCTIONS (by self-time)');
  console.log('─'.repeat(80));

  const totalProfileTimeMs = totalProfileTime / 1000;
  console.log(`  Total profile time: ${totalProfileTimeMs.toFixed(1)}ms`);
  console.log(`  Total nodes: ${nodes.length}`);
  console.log(`  Total samples: ${samples.length}`);
  console.log('');

  if (top20Functions.length > 0) {
    console.log('  ' + 'Self Time'.padStart(12) + '  ' + '%'.padStart(6) + '  ' + 'Function');
    console.log('  ' + '-'.repeat(12) + '  ' + '-'.repeat(6) + '  ' + '-'.repeat(50));

    for (const node of top20Functions) {
      const selfMs = (node.selfTime / 1000).toFixed(1);
      const pct = totalProfileTime > 0 ? ((node.selfTime / totalProfileTime) * 100).toFixed(1) : '0.0';
      const cf = node.callFrame;
      const urlShort = cf.url ? cf.url.split('/').slice(-2).join('/') : '(native)';
      const location = cf.url ? `${urlShort}:${cf.lineNumber}:${cf.columnNumber}` : '(native)';
      console.log(`  ${selfMs.padStart(10)}ms  ${pct.padStart(5)}%  ${cf.functionName || '(anonymous)'} — ${location}`);
    }
  }

  // Show idle vs active time
  const idleNode = nodes.find(n => n.callFrame.functionName === '(idle)');
  const programNode = nodes.find(n => n.callFrame.functionName === '(program)');
  const gcNode = nodes.find(n => n.callFrame.functionName === '(garbage collector)');
  const idleSelf = nodeMap.get(idleNode?.id)?.selfTime || 0;
  const programSelf = nodeMap.get(programNode?.id)?.selfTime || 0;
  const gcSelf = nodeMap.get(gcNode?.id)?.selfTime || 0;
  const activeSelf = totalProfileTime - idleSelf;

  console.log('\n  Time breakdown:');
  console.log(`    Active (non-idle):     ${(activeSelf / 1000).toFixed(1)}ms (${(activeSelf / totalProfileTime * 100).toFixed(1)}%)`);
  console.log(`    Idle:                  ${(idleSelf / 1000).toFixed(1)}ms (${(idleSelf / totalProfileTime * 100).toFixed(1)}%)`);
  console.log(`    Program overhead:      ${(programSelf / 1000).toFixed(1)}ms (${(programSelf / totalProfileTime * 100).toFixed(1)}%)`);
  console.log(`    GC:                    ${(gcSelf / 1000).toFixed(1)}ms (${(gcSelf / totalProfileTime * 100).toFixed(1)}%)`);

  // ─── Summary ───
  console.log('\n' + '─'.repeat(80));
  console.log('RESOURCE LOADING (Performance API — Top 20 by duration)');
  console.log('─'.repeat(80));

  const topResources = [...inPageData.resources]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 20);

  if (topResources.length > 0) {
    for (const res of topResources) {
      const urlShort = res.name.length > 65 ? '...' + res.name.slice(-62) : res.name;
      console.log(`  ${res.duration.toFixed(0).padStart(5)}ms  ${(res.transferSize / 1024).toFixed(1).padStart(7)}KB  ${res.initiatorType.padEnd(8)}  ${urlShort}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('END OF REPORT');
  console.log('='.repeat(80));

  await browser.close();
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
