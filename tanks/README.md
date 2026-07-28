# tanks

Multiplayer tank battle game for LAN play.

## Play it

Live at **[tanks.adamschaal.com](https://tanks.adamschaal.com)** — no setup required.

## Running locally

```bash
docker compose up
```

Then have everyone on the same network open their browser to `http://<your-ip>:3000`.

## Controls

**Standard Mode**

| Key | Action |
|-----|--------|
| W / S | Forward / reverse |
| A / D | Turn left / right |
| Mouse | Aim turret |
| Click / Space | Fire |

**Mouse-Drive Mode** (press M to toggle)

| Key | Action |
|-----|--------|
| Mouse | Steers tank and aims |
| W / S | Forward / reverse |
| Click / Space | Fire |

**Other**

| Key | Action |
|-----|--------|
| V | Toggle first-person view |

## Pickups

| Color | Pickup | Effect |
|-------|--------|--------|
| Yellow | Speed | 2x speed for 11s |
| Blue | Shield | Blocks one hit for 9s |
| Red | Ammo | 20 rounds of rapid fire |
| Green | Health | Restore 1 heart (max 5) |
| Gray | Bomb | Next shot is an area blast: -3 hearts or strips shield |
