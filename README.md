# Pocket Galaxy

A 3D galaxy you spin with a thumb. Every bright star is a GitHub project; the small stars orbiting it are its commits. Add it to your iPhone home screen from Safari (Share → Add to Home Screen).

## Add your own stars (classes, life events)

Edit `stars.json`. Each entry becomes a gold star:

```json
{ "stars": [
  { "name": "CSC 340", "kind": "class", "date": "2025-01-15", "note": "Software engineering", "url": "" }
] }
```

Only `name` is required. `date` decides how far from the core the star sits (oldest in the middle).

## Refresh the GitHub snapshot

The app loads `data.json` instantly and then checks GitHub for newer commits. To rebuild the snapshot:

```bash
python3 bake.py <github-username>
```
