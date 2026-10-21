import asyncio, json, sys
from playwright.async_api import async_playwright

URL = __import__("os").environ.get("MEETOWN_URL", "http://127.0.0.1:5173") + "/?room=e2e-room"
results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)

async def join(browser, name):
    ctx = await browser.new_context(permissions=["camera", "microphone"], viewport={"width": 1280, "height": 800})
    page = await ctx.new_page()
    logs = []
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}") if m.type in ("error",) else None)
    page.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
    await page.goto(URL)
    await page.fill("#display-name", name)
    await page.click("button.primary-button")
    await page.wait_for_selector(".meeting-shell", timeout=20000)
    return ctx, page, logs

async def remote_video_playing(page):
    return await page.evaluate("""() => {
      const v = [...document.querySelectorAll('.video-tile:not(.local-tile) video')];
      return v.length > 0 && v.every(x => x.videoWidth > 0 && !x.paused);
    }""")

async def remote_audio_energy(page):
    return await page.evaluate("""async () => {
      const el = [...document.querySelectorAll('audio')].find(a => a.srcObject);
      if (!el) return {found:false};
      const track = el.srcObject.getAudioTracks()[0];
      const ctx = new AudioContext(); await ctx.resume();
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an);
      const buf = new Float32Array(an.fftSize); let peak = 0;
      const end = performance.now() + 4000;
      while (performance.now() < end) { an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); await new Promise(r => setTimeout(r, 50)); }
      return {found:true, live: track.readyState, enabled: track.enabled, peak};
    }""")

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
        ctxA, A, logsA = await join(browser, "Ann")
        ctxB, B, logsB = await join(browser, "Bob")
        await asyncio.sleep(5)
        print("banners A:", await A.locator(".banner").all_inner_texts(), "| B:", await B.locator(".banner").all_inner_texts())

        for label, page in (("Ann", A), ("Bob", B)):
            cnt = await page.inner_text(".participant-count")
            check(f"{label} sees 2 participants", "2" in cnt, cnt.strip())
            check(f"{label} has 2 tiles", await page.locator(".video-tile").count() == 2)
            check(f"{label} sees remote video playing", await remote_video_playing(page))
        await A.screenshot(path="/tmp/shots/meeting-2p.png")

        e = await remote_audio_energy(B)
        check("Bob receives Ann's audio (non-silent)", e.get("found") and e.get("peak", 0) > 0.01, json.dumps(e))
        e = await remote_audio_energy(A)
        check("Ann receives Bob's audio (non-silent)", e.get("found") and e.get("peak", 0) > 0.01, json.dumps(e))

        # Mute / camera propagation
        await A.click("button.control-button:has-text('Mute')")
        await B.click("button.panel-tabs >> text=People") if False else None
        await B.click(".participant-count")
        await asyncio.sleep(1.5)
        people = await B.inner_text(".people-list")
        check("Bob sees Ann as Mic off", "Ann" in people and "Mic off" in people.split("Ann")[1].split("Bob")[0], people.replace("\n", " | "))
        check("Ann's tile shows muted badge for Bob", await B.locator(".video-tile:not(.local-tile) .mic-off-badge").count() == 1)
        await A.click("button.control-button:has-text('Stop video')")
        await asyncio.sleep(1.5)
        check("Ann's camera-off shows avatar on Bob's screen", await B.locator(".video-tile:not(.local-tile) .tile-avatar").count() == 1)
        await A.click("button.control-button:has-text('Start video')")
        await A.click("button.control-button:has-text('Unmute')")
        await asyncio.sleep(2)
        check("Camera back on for Bob", await remote_video_playing(B))

        # Chat
        await A.click("button.control-button:has-text('Chat')") if await A.locator(".meeting-panel .chat-panel").count() == 0 else None
        await A.click(".panel-tabs button:has-text('Chat')")
        await B.click(".panel-tabs button:has-text('Chat')")
        await A.fill(".chat-compose input", "hello from Ann")
        await A.press(".chat-compose input", "Enter")
        await asyncio.sleep(1)
        check("Chat delivered to Bob", "hello from Ann" in await B.inner_text(".chat-messages"))
        check("Chat echoed to sender", "hello from Ann" in await A.inner_text(".chat-messages"))

        # Notes
        await A.click(".panel-tabs button:has-text('Notes')"); await B.click(".panel-tabs button:has-text('Notes')")
        await A.fill(".notes-panel textarea", "Decision: ship Friday")
        await asyncio.sleep(2)
        check("Notes shared live", await B.input_value(".notes-panel textarea") == "Decision: ship Friday")

        # Captions: provider is down by design -> single non-blocking status, meeting unaffected
        await A.click(".panel-tabs button:has-text('Translate')")
        await asyncio.sleep(7)
        badge = await A.inner_text(".caption-state-badge")
        check("Caption outage shown as UNAVAILABLE (no crash)", badge.strip() == "UNAVAILABLE", badge)
        check("Meeting still fully working during caption outage", await remote_video_playing(A))
        await A.screenshot(path="/tmp/shots/captions-unavailable.png")

        # Settings: device pickers
        await A.click("button[title='Meeting settings']")
        await asyncio.sleep(1)
        sel = await A.locator(".settings-select").count()
        check("Device selectors rendered", sel >= 2, f"{sel} selects")
        await A.screenshot(path="/tmp/shots/settings.png")

        # Third participant + leave handling
        ctxC, C, logsC = await join(browser, "Cy")
        await asyncio.sleep(4)
        check("Three-way call: Ann sees 3 tiles", await A.locator(".video-tile").count() == 3)
        await A.screenshot(path="/tmp/shots/meeting-3p.png")
        await C.click(".leave-button")
        await asyncio.sleep(3)
        check("Cy leaves -> Ann back to 2 tiles", await A.locator(".video-tile").count() == 2)
        check("Cy sees the join screen after leaving", await C.locator(".join-card").count() == 1)

        # Cleanup check: tracks released on leave
        await B.click(".leave-button"); await asyncio.sleep(1)
        live = await B.evaluate("() => document.querySelectorAll('audio').length")
        check("Leaving removes remote audio elements", live == 0, str(live))

        errs = [l for l in logsA + logsB + logsC if "favicon" not in l]
        check("No console/page errors", not errs, "; ".join(errs)[:300])
        await browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results)-len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)
asyncio.run(main())
