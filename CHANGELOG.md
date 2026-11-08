# Changelog

## 0.3.4

- Away from the PC's network, Moonride now goes through jap-wireproxy (mgu-apps, your own WireGuard server) or, as
  the backup, IterioDev's Tailscale (`iteriodev-tailscale` from IterioDev/car-apps, with its SOCKS5 proxy enabled).
  It uses the first one that reaches the PC. Setting `MGU_SOCKS` in the service lists them in order.
- Moonride no longer uses the `jap-tailscale` tool. The "Tailscale: sign in" chip and its QR code are gone: sign in
  with IterioDev's Tailscale app.
- The UDP part of the relay sends to the address the proxy gives, so it works with a proxy that is not on
  127.0.0.1.
- The app and the streaming service are both 0.3.4.

## 0.3.3

- The app is now in English: the home page, the gamepads page, the pairing, Tailscale and loading screens, the
  messages, the settings and the bar buttons. The statistics overlay writes decimals with a point.
- The gamepads page no longer cuts off the top of its first heading.
- README: screenshots of the app.

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
