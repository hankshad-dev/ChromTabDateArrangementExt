# Chrome Tab Date Arrangement Extension

An automated Manifest V3 Chrome extension that organizes unpinned tabs into native Chrome Tab Groups based on when they were last accessed.

## Key Features

- **7 Exact Date Buckets**:
  - `Archived` (Older than 90 days) — Grey
  - `Last 90 Days` (Past 90 days) — Purple
  - `This Month` (Current calendar month) — Pink
  - `Last Week` (Preceding calendar week, Mon–Sun) — Red
  - `This Week` (Current calendar week starting Monday, ISO 8601) — Yellow
  - `Yesterday` (Previous calendar day) — Blue
  - `Today` (Current calendar day) — Green

- **Visual Sequence**: Arranged on the tab strip from **Oldest to Newest** (left to right: `Archived` &rarr; `Last 90 Days` &rarr; `This Month` &rarr; `Last Week` &rarr; `This Week` &rarr; `Yesterday` &rarr; `Today`).
- **Focus & Declutter**: All older tab groups are automatically collapsed; only the **Today** group stays expanded.
- **Intra-Group Timeline**: Tabs within each group are ordered chronologically (most recently accessed placed on the right).
- **Tab Activation**: Activating any tab updates its timestamp and immediately moves it to the **Today** group.
- **New Blank Tabs**: New tabs (including `chrome://newtab`) immediately join **Today**.
- **Per-Window Isolation**: Strict window isolation with no cross-window tab shifting.
- **Privacy First**: Completely ignores Incognito windows and pinned tabs.
- **Debounced & Atomic**: 500 ms per-window debouncing with sequential locking guarantees smooth animations without UI flicker or Chrome API rate limits.
- **Background Automation**: Pure background service worker with `chrome.alarms` to transition idle tabs across midnight and day thresholds.

## Installation Instructions

1. Open Google Chrome.
2. Navigate to `chrome://extensions`.
3. Enable **Developer mode** via the toggle in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select this directory:
   `/Users/hosseinshad/Documents/Antigravity-Projects/ChromeTabDateArrangementExt`
6. The extension is now running. Open several tabs or activate existing ones to watch them automatically organize into date groups!
