// Judges whether a planned council fits the machine it is about to run on.
//
// Hardware load comes from how many CLI processes run *at the same time*, not
// from how long the session lasts. Rounds add turns and cost, but in debate
// mode only as many members as the "talking at once" setting allow are alive
// together (a cut-off member's reaction reuses their own slot, and the clerk
// runs after everyone else has finished). Solo critique starts every member
// together.

window.Resources = (function () {
  'use strict';

  // Typical peak memory of one non-interactive turn, per CLI, in MB. These are
  // deliberately conservative: a turn holds the CLI runtime plus the whole
  // conversation context, well above the CLI's bare start-up footprint.
  const PROCESS_MB = { 'claude-code': 400, opencode: 350, codex: 250 };
  const DEFAULT_PROCESS_MB = 400;

  // Codebase mode adds file reads and search helpers (ripgrep) to each turn.
  const CODEBASE_EXTRA_MB = 150;

  // Memory to leave for the OS, the app's own webview and whatever else the
  // user has open. Below this, macOS and Windows start compressing or swapping.
  const MIN_HEADROOM_MB = 1024;
  const HEADROOM_FRACTION = 0.1;

  // A turn mostly waits on the network; CPU use comes in bursts at start-up
  // and while streaming output is parsed. Half a core each is a fair average.
  const CPU_PER_PROCESS = 0.5;

  // Debate members talking at once when the plan does not say.
  const DEFAULT_OVERLAP = 2;

  // Above this share of spare memory, warn before the session starts.
  const HEAVY_FRACTION = 0.5;

  function processMb(harness, codebase) {
    return (PROCESS_MB[harness] || DEFAULT_PROCESS_MB) + (codebase ? CODEBASE_EXTRA_MB : 0);
  }

  function fmtGb(mb) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }

  /**
   * plan: { mode: 'debate'|'solo', rounds, overlap, codebase: bool, harnesses: [harness per member] }
   * res:  { total_memory_mb, available_memory_mb, logical_cpus, load_average }
   * Returns { level: 'ok'|'heavy'|'strain', peakProcesses, peakMb, spareMb, turns, reasons, advice }.
   */
  function assess(plan, res) {
    const harnesses = plan.harnesses || [];
    const members = harnesses.length;
    const perMember = harnesses
      .map((h) => processMb(h, plan.codebase))
      .sort((a, b) => b - a); // Worst case: the heaviest members overlap.

    const overlap = Math.max(1, Number(plan.overlap) || DEFAULT_OVERLAP);
    const peakProcesses = plan.mode === 'solo' ? members : Math.min(members, overlap);
    const peakMb = perMember.slice(0, peakProcesses).reduce((sum, mb) => sum + mb, 0);
    const turns = plan.mode === 'solo' ? members : members * Math.max(1, plan.rounds || 1);

    const total = res.total_memory_mb || 0;
    const headroom = Math.max(MIN_HEADROOM_MB, total * HEADROOM_FRACTION);
    const spareMb = Math.max(0, (res.available_memory_mb || 0) - headroom);
    const cpus = Math.max(1, res.logical_cpus || 1);
    const load = res.load_average || 0;

    const reasons = [];
    const advice = [];
    let level = 'ok';
    const raise = (to) => {
      if (to === 'strain' || (to === 'heavy' && level === 'ok')) level = to;
    };

    const procWord = peakProcesses === 1 ? 'process' : 'processes';
    if (peakMb > spareMb) {
      raise('strain');
      reasons.push(
        `Up to ${peakProcesses} AI ${procWord} at once need about ${fmtGb(peakMb)}, ` +
        `but only about ${fmtGb(spareMb)} is free after leaving room for your other apps.`
      );
    } else if (peakMb > spareMb * HEAVY_FRACTION) {
      raise('heavy');
      reasons.push(
        `Up to ${peakProcesses} AI ${procWord} at once will use about ${fmtGb(peakMb)} ` +
        `of the ${fmtGb(spareMb)} that is comfortably free.`
      );
    }

    // The load average counts work already queued for the CPUs; ours adds to it.
    const cpuDemand = load + peakProcesses * CPU_PER_PROCESS;
    if (cpuDemand > cpus * 1.5) {
      raise('strain');
      reasons.push(`Your ${cpus} CPU cores are already busy (load ${load.toFixed(1)}), and this adds ${peakProcesses} more AI ${procWord}.`);
    } else if (cpuDemand > cpus) {
      raise('heavy');
      reasons.push(`Your ${cpus} CPU cores are fairly busy (load ${load.toFixed(1)}).`);
    }

    if (level !== 'ok') {
      const avg = perMember.length ? perMember.reduce((a, b) => a + b, 0) / perMember.length : DEFAULT_PROCESS_MB;
      const fit = Math.max(1, Math.floor(spareMb / avg));
      if (plan.mode === 'solo' && members > DEFAULT_OVERLAP) {
        advice.push(`Use Debate mode, which runs ${DEFAULT_OVERLAP} members at a time by default.`);
        if (fit < members) advice.push(`Or select ${fit} member${fit === 1 ? '' : 's'} or fewer for Solo critique.`);
      }
      if (plan.mode !== 'solo' && peakProcesses > DEFAULT_OVERLAP) {
        advice.push(`Lower "Talking at once" in Settings; it is set to ${overlap > members ? 'everyone' : overlap}.`);
      }
      if (plan.codebase) advice.push('Clearing the codebase directory saves memory on every turn.');
      advice.push('Closing other heavy apps frees memory and CPU.');
    }

    return { level, peakProcesses, peakMb, spareMb, turns, reasons, advice };
  }

  return { assess, processMb, PROCESS_MB, DEFAULT_OVERLAP };
})();
