# Field Measure

A phone app for capturing house measurements on site: draw the
footprint, attach dimensions to walls and openings, record heights,
then take the result back to the office for SketchUp.

Built for Roberts & Associates field work. Replaces a paper sketch
with dimensions scribbled on it.

## What it does

- Draw a building footprint, one or more outlines per job
- Attach measurements to each wall segment
- Record openings (windows, doors) along a wall
- Capture heights, including foundation height
- Flags measurements you haven't taken yet, so you don't get back
  to the office and find a gap
- Photos, each labelled with the wall, opening or feature it shows; shrunk
  to 2048 px on the phone and backed up to Supabase Storage
- Several jobs at once, switchable
- Works with no signal; syncs when you're back in range

## How it's put together

Plain HTML, CSS and JavaScript — no build step. Hosted on GitHub
Pages, installable to an iPhone home screen.

- `index.html` — the whole app
- `storage.js` — the only file that knows where data lives
- `photos.js` — photos: shrinking, keeping them on the phone, backing them up
- `config.js` — connection settings
- `sw.js` — offline support
- `supabase-setup.sql` — the database table and its security rules
