/**
 * Chrome Tab Date Arrangement Extension
 * Service Worker (background.js) - Manifest V3
 *
 * Automatically organizes unpinned tabs into native tab groups based on last-accessed time.
 * Ordering: Oldest to Newest (Archived -> Last 90 Days -> This Month -> Last Week -> This Week -> Yesterday -> Today)
 */

// --- 1. Bucket Definitions & Configuration ---

const BUCKET_DEFINITIONS = [
  { key: 'Archived', title: 'Archived', color: 'grey', collapsed: true },
  { key: 'Last 90 Days', title: 'Last 90 Days', color: 'purple', collapsed: true },
  { key: 'This Month', title: 'This Month', color: 'pink', collapsed: true },
  { key: 'Last Week', title: 'Last Week', color: 'red', collapsed: true },
  { key: 'This Week', title: 'This Week', color: 'yellow', collapsed: true },
  { key: 'Yesterday', title: 'Yesterday', color: 'blue', collapsed: true },
  { key: 'Today', title: 'Today', color: 'green', collapsed: false }
];

const TAB_TIMESTAMPS_KEY = 'tabTimestamps';
const DEBOUNCE_DELAY_MS = 500;
const AGING_ALARM_NAME = 'periodicTabAging';
const MIDNIGHT_ALARM_NAME = 'midnightCheck';

// In-memory queues and timers for debouncing per window
const debounceTimers = new Map();
const windowProcessingLocks = new Set();
const windowPendingRerun = new Set();

// --- 2. Local Timezone Date & Bucket Calculations ---

/**
 * Calculates which date bucket a timestamp belongs to, strictly in the user's local timezone.
 *
 * Precedence hierarchy:
 * 1. Today (>= today 00:00:00)
 * 2. Yesterday (>= yesterday 00:00:00)
 * 3. This Week (>= current week Monday 00:00:00, ISO 8601)
 * 4. Last Week (>= previous week Monday 00:00:00)
 * 5. This Month (>= 1st of current calendar month 00:00:00)
 * 6. Last 90 Days (>= rolling 90 days ago)
 * 7. Archived (older than 90 days)
 *
 * @param {number} timestamp - Unix epoch in milliseconds
 * @returns {string} Bucket key
 */
function getBucketKey(timestamp) {
  const now = new Date();

  // Midnight today in local timezone
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();

  // Midnight yesterday in local timezone
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0).getTime();

  // Monday of current week (ISO 8601): getDay() is 0 for Sunday, 1 for Monday, ..., 6 for Saturday
  const day = now.getDay();
  const diffToMonday = (day === 0 ? 6 : day - 1);
  const startOfThisWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday, 0, 0, 0, 0).getTime();

  // Monday of previous week
  const startOfLastWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday - 7, 0, 0, 0, 0).getTime();

  // 1st of current calendar month
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();

  // 90 rolling days ago
  const startOfLast90Days = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90, 0, 0, 0, 0).getTime();

  if (timestamp >= startOfToday) {
    return 'Today';
  } else if (timestamp >= startOfYesterday) {
    return 'Yesterday';
  } else if (timestamp >= startOfThisWeek) {
    return 'This Week';
  } else if (timestamp >= startOfLastWeek) {
    return 'Last Week';
  } else if (timestamp >= startOfThisMonth) {
    return 'This Month';
  } else if (timestamp >= startOfLast90Days) {
    return 'Last 90 Days';
  } else {
    return 'Archived';
  }
}

// --- 3. Persistent Timestamp Storage ---

/**
 * Retrieves all stored tab timestamps from chrome.storage.local.
 * @returns {Promise<Record<string, number>>}
 */
async function getAllTimestamps() {
  const data = await chrome.storage.local.get(TAB_TIMESTAMPS_KEY);
  return data[TAB_TIMESTAMPS_KEY] || {};
}

/**
 * Persists an updated timestamp for a specific tab.
 * @param {number} tabId
 * @param {number} timestamp
 */
async function setTabTimestamp(tabId, timestamp) {
  const timestamps = await getAllTimestamps();
  timestamps[String(tabId)] = timestamp;
  await chrome.storage.local.set({ [TAB_TIMESTAMPS_KEY]: timestamps });
}

/**
 * Removes a closed tab's timestamp from persistent storage.
 * @param {number} tabId
 */
async function removeTabTimestamp(tabId) {
  const timestamps = await getAllTimestamps();
  const idStr = String(tabId);
  if (timestamps[idStr]) {
    delete timestamps[idStr];
    await chrome.storage.local.set({ [TAB_TIMESTAMPS_KEY]: timestamps });
  }
}

/**
 * Cleans up stored tab IDs that no longer belong to any currently open window.
 */
async function pruneOrphanTimestamps() {
  try {
    const windows = await chrome.windows.getAll({ populate: true });
    const liveTabIds = new Set();
    for (const win of windows) {
      if (!win.incognito && win.tabs) {
        for (const tab of win.tabs) {
          liveTabIds.add(String(tab.id));
        }
      }
    }

    const timestamps = await getAllTimestamps();
    let changed = false;
    for (const storedId of Object.keys(timestamps)) {
      if (!liveTabIds.has(storedId)) {
        delete timestamps[storedId];
        changed = true;
      }
    }

    if (changed) {
      await chrome.storage.local.set({ [TAB_TIMESTAMPS_KEY]: timestamps });
    }
  } catch (err) {
    console.error('Failed to prune orphan timestamps:', err);
  }
}

// --- 4. Debounced, Serialized Tab Organization Engine ---

/**
 * Schedules a debounced reorganization for a specific window.
 * Ensures operations on the same window never run concurrently.
 * @param {number} windowId
 */
function queueWindowOrganization(windowId) {
  if (!windowId || windowId === chrome.windows.WINDOW_ID_NONE) return;

  if (debounceTimers.has(windowId)) {
    clearTimeout(debounceTimers.get(windowId));
  }

  const timer = setTimeout(async () => {
    debounceTimers.delete(windowId);
    await executeWindowOrganization(windowId);
  }, DEBOUNCE_DELAY_MS);

  debounceTimers.set(windowId, timer);
}

/**
 * Executes reorganization with concurrency locking per window.
 * @param {number} windowId
 */
async function executeWindowOrganization(windowId) {
  if (windowProcessingLocks.has(windowId)) {
    windowPendingRerun.add(windowId);
    return;
  }

  windowProcessingLocks.add(windowId);
  try {
    await organizeWindowTabs(windowId);
  } catch (err) {
    console.error(`Error organizing tabs in window ${windowId}:`, err);
  } finally {
    windowProcessingLocks.delete(windowId);
    if (windowPendingRerun.has(windowId)) {
      windowPendingRerun.delete(windowId);
      queueWindowOrganization(windowId);
    }
  }
}

/**
 * Core tab organization logic for a single window:
 * - Ignores incognito windows and pinned tabs.
 * - Buckets tabs by last-accessed timestamp.
 * - Sorts chronologically within groups.
 * - Arranges tab groups from Oldest to Newest.
 * - Collapses historical groups and keeps 'Today' expanded.
 * @param {number} windowId
 */
async function organizeWindowTabs(windowId) {
  let win;
  try {
    win = await chrome.windows.get(windowId, { populate: true });
  } catch {
    // Window may have closed
    return;
  }

  // Skip Incognito windows and windows without tabs
  if (!win || win.incognito || !win.tabs || win.tabs.length === 0) {
    return;
  }

  // Pinned tabs are left untouched at index 0..k
  const pinnedTabs = win.tabs.filter(t => t.pinned);
  const unpinnedTabs = win.tabs.filter(t => !t.pinned);

  if (unpinnedTabs.length === 0) {
    return;
  }

  // Load and seed timestamps
  const timestamps = await getAllTimestamps();
  let updatedStorage = false;

  for (const tab of unpinnedTabs) {
    const idStr = String(tab.id);
    if (!timestamps[idStr]) {
      // Use Chrome native tab.lastAccessed if available, fallback to Date.now()
      timestamps[idStr] = tab.lastAccessed || Date.now();
      updatedStorage = true;
    }
  }

  if (updatedStorage) {
    await chrome.storage.local.set({ [TAB_TIMESTAMPS_KEY]: timestamps });
  }

  // Categorize unpinned tabs into buckets
  const bucketBuckets = new Map();
  for (const def of BUCKET_DEFINITIONS) {
    bucketBuckets.set(def.key, []);
  }

  for (const tab of unpinnedTabs) {
    const ts = timestamps[String(tab.id)] || tab.lastAccessed || Date.now();
    const bucketKey = getBucketKey(ts);
    bucketBuckets.get(bucketKey).push({ tab, timestamp: ts });
  }

  // Sort tabs chronologically within each bucket (oldest to newest, right-aligned timeline)
  for (const [key, items] of bucketBuckets.entries()) {
    items.sort((a, b) => a.timestamp - b.timestamp);
  }

  // Determine active buckets in strict left-to-right order (Oldest -> Newest)
  const activeBuckets = BUCKET_DEFINITIONS.filter(def => bucketBuckets.get(def.key).length > 0);

  // Query existing tab groups in this window to reuse matching groups
  const existingGroups = await chrome.tabGroups.query({ windowId });
  const titleToGroupMap = new Map();
  for (const grp of existingGroups) {
    if (grp.title) {
      titleToGroupMap.set(grp.title, grp);
    }
  }

  // Group each bucket's tabs
  const bucketGroupIds = new Map();
  for (const def of activeBuckets) {
    const tabIds = bucketBuckets.get(def.key).map(item => item.tab.id);
    let groupId;

    if (titleToGroupMap.has(def.title)) {
      const existingGrp = titleToGroupMap.get(def.title);
      groupId = await chrome.tabs.group({
        tabIds: tabIds,
        groupId: existingGrp.id
      });
    } else {
      groupId = await chrome.tabs.group({
        tabIds: tabIds,
        createProperties: { windowId }
      });
    }

    bucketGroupIds.set(def.key, groupId);

    // Apply title, color, and initial collapsed state
    await chrome.tabGroups.update(groupId, {
      title: def.title,
      color: def.color,
      collapsed: def.collapsed
    });
  }

  // Build target ordered tab IDs across all active buckets
  const targetOrderedTabIds = [];
  for (const def of activeBuckets) {
    for (const item of bucketBuckets.get(def.key)) {
      targetOrderedTabIds.push(item.tab.id);
    }
  }

  // Verify current unpinned tab ordering in the window
  const currentTabs = await chrome.tabs.query({ windowId });
  const currentUnpinnedIds = currentTabs.filter(t => !t.pinned).map(t => t.id);

  const orderMatches = currentUnpinnedIds.length === targetOrderedTabIds.length &&
    currentUnpinnedIds.every((id, idx) => id === targetOrderedTabIds[idx]);

  if (!orderMatches) {
    // Move all unpinned tabs as an ordered block immediately following pinned tabs
    const startIndex = pinnedTabs.length;
    await chrome.tabs.move(targetOrderedTabIds, { index: startIndex });
  }

  // Ensure collapse state is strictly maintained:
  // Older groups collapsed, 'Today' group expanded
  for (const def of activeBuckets) {
    const groupId = bucketGroupIds.get(def.key);
    if (groupId) {
      try {
        await chrome.tabGroups.update(groupId, {
          collapsed: def.collapsed
        });
      } catch {
        // Safe to ignore if group was closed during reorganization
      }
    }
  }
}

// --- 5. Periodic Alarms (Idle Aging & Local Midnight) ---

/**
 * Configures periodic and midnight alarms.
 */
function setupAlarms() {
  // Periodic check every 30 minutes to age idle tabs
  chrome.alarms.create(AGING_ALARM_NAME, { periodInMinutes: 30 });

  // Schedule next local midnight check
  scheduleMidnightAlarm();
}

/**
 * Calculates milliseconds until next local midnight and registers a one-shot alarm.
 */
function scheduleMidnightAlarm() {
  const now = new Date();
  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    5 // 5 seconds past midnight to ensure date rollover
  ).getTime();

  chrome.alarms.create(MIDNIGHT_ALARM_NAME, { when: nextMidnight });
}

// Listen for alarm triggers
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AGING_ALARM_NAME || alarm.name === MIDNIGHT_ALARM_NAME) {
    if (alarm.name === MIDNIGHT_ALARM_NAME) {
      scheduleMidnightAlarm();
    }

    // Trigger reorganization for all open normal windows
    const windows = await chrome.windows.getAll();
    for (const win of windows) {
      if (!win.incognito) {
        queueWindowOrganization(win.id);
      }
    }
  }
});

// --- 6. Event Listeners ---

/**
 * On tab activation:
 * Update timestamp to Date.now() and immediately move to 'Today' via debounced queue.
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.pinned) return;

    const win = await chrome.windows.get(activeInfo.windowId);
    if (win.incognito) return;

    await setTabTimestamp(activeInfo.tabId, Date.now());
    queueWindowOrganization(activeInfo.windowId);
  } catch (err) {
    console.error('tabs.onActivated handler error:', err);
  }
});

/**
 * On tab created:
 * Immediately mark as Date.now() so new blank tabs belong to 'Today'.
 */
chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    if (tab.pinned) return;

    if (tab.windowId) {
      const win = await chrome.windows.get(tab.windowId);
      if (win.incognito) return;
    }

    await setTabTimestamp(tab.id, Date.now());
    queueWindowOrganization(tab.windowId);
  } catch (err) {
    console.error('tabs.onCreated handler error:', err);
  }
});

/**
 * On tab updated:
 * When active tab navigates or loads, update its timestamp.
 * When a background tab updates, ensure window groups stay consistent.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    if (tab.pinned) return;

    const win = await chrome.windows.get(tab.windowId);
    if (win.incognito) return;

    if (changeInfo.status === 'complete' || changeInfo.url) {
      if (tab.active) {
        await setTabTimestamp(tabId, Date.now());
      }
      queueWindowOrganization(tab.windowId);
    }
  } catch (err) {
    console.error('tabs.onUpdated handler error:', err);
  }
});

/**
 * On tab closed:
 * Remove timestamp from storage to prevent unbounded growth and re-evaluate window.
 */
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  removeTabTimestamp(tabId);
  if (!removeInfo.isWindowClosing) {
    queueWindowOrganization(removeInfo.windowId);
  }
});

/**
 * On tab moved across windows.
 */
chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  queueWindowOrganization(attachInfo.newWindowId);
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  queueWindowOrganization(detachInfo.oldWindowId);
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  try {
    await removeTabTimestamp(removedTabId);
    await setTabTimestamp(addedTabId, Date.now());
    const tab = await chrome.tabs.get(addedTabId);
    queueWindowOrganization(tab.windowId);
  } catch (err) {
    console.error('tabs.onReplaced handler error:', err);
  }
});

// --- 7. Lifecycle & Initialization ---

/**
 * Scans all windows on startup/install and organizes tabs.
 */
async function initializeExtension() {
  setupAlarms();
  await pruneOrphanTimestamps();

  const windows = await chrome.windows.getAll({ populate: true });
  for (const win of windows) {
    if (!win.incognito) {
      queueWindowOrganization(win.id);
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
  initializeExtension();
});
