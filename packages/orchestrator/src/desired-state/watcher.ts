import { watch, type FSWatcher } from "chokidar";

export interface DesiredStateWatcherOptions {
  debounceMs?: number;
  pollIntervalMs?: number;
}

export interface DesiredStateWatcherHandle {
  /** Programmatic trigger equivalent to a filesystem change (POST /nudge). */
  nudge: () => void;
  stop: () => Promise<void>;
}

/**
 * Watches wanfw_desired for changes (spec §7 triggers): chokidar watch with
 * a debounce so a burst of file writes collapses into one reconcile, plus a
 * poll-interval fallback for filesystems where inotify-style events don't
 * propagate reliably (some network/overlay mounts). `nudge()` gives the
 * status-socket's POST /nudge a matching trigger path.
 */
export function watchDesiredState(
  desiredDir: string,
  onChange: () => void,
  options: DesiredStateWatcherOptions = {},
): DesiredStateWatcherHandle {
  const debounceMs = options.debounceMs ?? 2_000;
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;

  let debounceTimer: NodeJS.Timeout | undefined;
  function scheduleChange(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onChange, debounceMs);
  }

  const watcher: FSWatcher = watch(desiredDir, {
    ignoreInitial: true,
    persistent: true,
  });
  watcher.on("add", scheduleChange);
  watcher.on("change", scheduleChange);
  watcher.on("unlink", scheduleChange);

  const pollTimer: NodeJS.Timeout = setInterval(onChange, pollIntervalMs);

  return {
    nudge: () => scheduleChange(),
    stop: async () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(pollTimer);
      await watcher.close();
    },
  };
}
