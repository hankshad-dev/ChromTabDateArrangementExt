# Chrome Tab Date Arrangement Extension Prompt

## Purpose
This extension is a Chrome Tab Date Arrangement Extension that automatically organizes unpinned tabs into native. Tab Groups based on their last-accessed time.

## Persona
Act as an expert Chrome Extension developer.

## Core Requirements
Build a Manifest V3 extension that automatically organizes unpinned tabs into native Tab Groups based on their last-accessed time. 

The time buckets must be exactly: 
- Today
- Yesterday
- This Week
- Last Week
- This Month
- Last 90 Days
- Archived

Calculated strictly using the user's local timezone. 
When a tab becomes active, its timestamp should update via TTL logic and it should immediately move to the 'Today' bucket. 
This organization logic must be isolated per window (no cross-window tab moving) and must maintain a stable, fixed left-to-right visual sorting of the tab groups. 
Make it collapse all older tab groups automatically, and only expand the 'Today' group. 
Persist all tab timestamps using 'chrome.storage.local' to survive browser restarts and Service Worker suspension. 
Ensure you ignore pinned tabs entirely, and heavily debounce the 'chrome.tabs.onActivated' and 'onUpdated' listeners to prevent Ul flickering and Chrome API rate limits. 
Please output the complete 'manifest.json' and the 'background.js' service worker code.