# Changelog

## 0.3.2

- A lost connection no longer closes the game on the PC. Moonride keeps retrying the link for 10 minutes and resumes
  the same game when the network comes back (for example when the car switches from the phone to Wi-Fi).
- Switching to another car app while streaming keeps the game running on the PC, with no time limit: come back to
  Moonride and it resumes where you left it. Back (or Stop) still ends the game. Setting "Resume", on by default.
- New "Quitter" entry in the "•••" menu: ends the game on the PC and asks the iDrive to close the app now, instead of
  keeping it in memory until two other apps were opened. If the iDrive refuses, a message says so.
- Car audio: the CarLifeMedia audio route is marked available while Moonride is shown, so the sound reliably connects,
  and old audio connections are cleared at start.
- Diagnostics: one line of stream statistics every 10 s in the car's journal (frame rate, lost frames, round trip,
  audio packets, with dropped audio split into "late" and "buffer full"), so a stutter can be traced afterwards.

## 0.3.1

- When the car does not report its speed, the page now says so ("vitesse illisible") instead of waiting for the
  car to stop. Streaming stays blocked in that case, as before.

## 0.3.0

First public release.
