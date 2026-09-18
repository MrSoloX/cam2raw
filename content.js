(function () {
    if (window.__cameraInjected) {
        console.warn(`[FADE-CAM] ⚠️ Повторная инъекция пропущена (уже injected в ${window.location.href})`);
        return;
    }
    window.__cameraInjected = true;
    window.__fadeCamActive = false;
    window.__fadeCamMode = 'none';

    const FRAME_INFO = `${window === window.top ? 'TOP' : 'IFRAME'}[${window.location.href.substring(0, 50)}]`;
    
    const LOG = (msg, ...args) => console.log(`[FADE-CAM ${FRAME_INFO}] ${msg}`, ...args);
    const WARN = (msg, ...args) => console.warn(`[FADE-CAM ${FRAME_INFO}] ${msg}`, ...args);
    const ERR = (msg, ...args) => console.error(`[FADE-CAM ${FRAME_INFO}] ${msg}`, ...args);

    WARN("!!! SILHOUETTE ENGINE STARTED !!!");
    LOG(`URL: ${window.location.href}`);
    LOG(`User Agent: ${navigator.userAgent}`);
    LOG(`Timestamp: ${new Date().toISOString()}`);

    // ============================================================
    // ⚙️ КОНФИГУРАЦИЯ
    // ============================================================
    const TARGET_W = 1280;
    const TARGET_H = 720;
    const PROC_W = 320;
    const PROC_H = 180;
    const EMA_ALPHA = 0.3;
    const BIN_THRESHOLD = 0.7;
    const CLOSE_R = 2;
    const OPEN_R = 2;

    // ============================================================
    // Состояние
    // ============================================================
    let memoryCanvas = null, ctx = null;
    let maskCanvas = null, maskCtx = null;
    let procCanvas = null, procCtx = null;
    let upCanvas = null, upCtx = null;
    let imageSegmenter = null, mpReady = false;
    let frameCount = 0, segSuccessCount = 0, segErrorCount = 0;
    let prevFloatMask = null;
    let customVideoEl = null;
    let customBgImage = null;

    // ============================================================
    // СЛУШАТЕЛИ СОБЫТИЙ (с логированием)
    // ============================================================
    
    // FADE_CAM_TOGGLE
    window.addEventListener('FADE_CAM_TOGGLE', (event) => {
        const d = event.detail || {};
        const oldActive = window.__fadeCamActive;
        const oldMode = window.__fadeCamMode;
        
        window.__fadeCamActive = !!d.enabled;
        window.__fadeCamMode = d.mode || 'none';
        prevFloatMask = null;
        
        WARN(`🎯 TOGGLE EVENT: active ${oldActive}→${window.__fadeCamActive}, mode ${oldMode}→${window.__fadeCamMode}`);
        LOG(`  event.detail:`, d);
    });

    // FADE_CAM_SET_MEDIA
    window.addEventListener('FADE_CAM_SET_MEDIA', async (event) => {
        const d = event.detail || {};
        LOG(`📥 SET_MEDIA EVENT: type=${d.type}, dataSize=${d.data ? d.data.length : 0}`);

        if (d.type === 'video' && d.data) {
            try {
                if (!customVideoEl) {
                    customVideoEl = document.createElement('video');
                    customVideoEl.loop = true;
                    customVideoEl.muted = true;
                    customVideoEl.playsInline = true;
                    customVideoEl.setAttribute('playsinline', '');
                    LOG('  создан новый video element');
                }
                customVideoEl.src = d.data;
                customVideoEl.load();
                await customVideoEl.play();
                LOG(`  ✅ Видео загружено: ${customVideoEl.videoWidth}x${customVideoEl.videoHeight}, readyState=${customVideoEl.readyState}`);
            } catch (e) {
                ERR(`  ❌ Ошибка загрузки видео: ${e.message}`);
            }
        }

        if (d.type === 'bg' && d.data) {
            try {
                customBgImage = new Image();
                customBgImage.src = d.data;
                await customBgImage.decode();
                LOG(`  ✅ Фон загружен: ${customBgImage.width}x${customBgImage.height}`);
            } catch (e) {
                ERR(`  ❌ Ошибка загрузки фона: ${e.message}`);
            }
        }

        if (d.type === 'clear_video') {
            if (customVideoEl) { customVideoEl.pause(); customVideoEl.src = ''; }
            customVideoEl = null;
            LOG(`  ✅ Видео очищено`);
        }

        if (d.type === 'clear_bg') {
            customBgImage = null;
            LOG(`  ✅ Фон очищен`);
        }
    });

    // BroadcastChannel — резервный канал от popup
    try {
        const bc = new BroadcastChannel('fade_cam_control');
        LOG('✅ BroadcastChannel создан (резервный канал)');
        bc.onmessage = (event) => {
            LOG(`📡 BroadcastChannel RX:`, event.data);
            if (event.data.type === 'TOGGLE') {
                const oldActive = window.__fadeCamActive;
                const oldMode = window.__fadeCamMode;
                window.__fadeCamActive = !!event.data.enabled;
                window.__fadeCamMode = event.data.mode || 'none';
                prevFloatMask = null;
                WARN(`🎯 BroadcastChannel TOGGLE: active ${oldActive}→${window.__fadeCamActive}, mode ${oldMode}→${window.__fadeCamMode}`);
            }
            if (event.data.type === 'SET_MEDIA') {
                window.dispatchEvent(new CustomEvent('FADE_CAM_SET_MEDIA', {
                    detail: { type: event.data.mediaType, data: event.data.data }
                }));
            }
        };
    } catch (e) {
        ERR(`❌ BroadcastChannel не создан: ${e.message}`);
    }

    // ============================================================
    // Мониторинг: проверяем значения window.__fadeCamActive каждые 2 сек
    // ============================================================
    let monitorLastActive = false;
    let monitorLastMode = 'none';
    setInterval(() => {
        if (window.__fadeCamActive !== monitorLastActive || window.__fadeCamMode !== monitorLastMode) {
            LOG(`🔍 MONITOR: active ${monitorLastActive}→${window.__fadeCamActive}, mode ${monitorLastMode}→${window.__fadeCamMode}`);
            monitorLastActive = window.__fadeCamActive;
            monitorLastMode = window.__fadeCamMode;
        }
    }, 2000);

    // ============================================================
    // Морфология
    // ============================================================
    function fastErode(m, w, h, r) {
        const tmp = new Uint8Array(w * h);
        const out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            const row = y * w;
            for (let x = 0; x < w; x++) {
                let v = 1;
                for (let d = -r; d <= r && v; d++) {
                    const nx = x + d;
                    if (nx >= 0 && nx < w ? m[row + nx] === 0 : true) v = 0;
                }
                tmp[row + x] = v;
            }
        }
        for (let x = 0; x < w; x++) {
            for (let y = 0; y < h; y++) {
                let v = 1;
                for (let d = -r; d <= r && v; d++) {
                    const ny = y + d;
                    if (ny >= 0 && ny < h ? tmp[ny * w + x] === 0 : true) v = 0;
                }
                out[y * w + x] = v;
            }
        }
        return out;
    }

    function fastDilate(m, w, h, r) {
        const tmp = new Uint8Array(w * h);
        const out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            const row = y * w;
            for (let x = 0; x < w; x++) {
                let v = 0;
                for (let d = -r; d <= r && !v; d++) {
                    const nx = x + d;
                    if (nx >= 0 && nx < w && m[row + nx]) v = 1;
                }
                tmp[row + x] = v;
            }
        }
        for (let x = 0; x < w; x++) {
            for (let y = 0; y < h; y++) {
                let v = 0;
                for (let d = -r; d <= r && !v; d++) {
                    const ny = y + d;
                    if (ny >= 0 && ny < h && tmp[ny * w + x]) v = 1;
                }
                out[y * w + x] = v;
            }
        }
        return out;
    }

    function keepLargest(mask, w, h) {
        const n = w * h;
        const labels = new Int32Array(n);
        let label = 0, bestLabel = 0, bestSize = 0;
        const stack = [];
        for (let i = 0; i < n; i++) {
            if (mask[i] && !labels[i]) {
                label++;
                let size = 0;
                stack.push(i);
                labels[i] = label;
                while (stack.length) {
                    const ci = stack.pop();
                    size++;
                    const cx = ci % w, cy = (ci - cx) / w;
                    if (cy > 0)   { const p = ci-w; if (mask[p] && !labels[p]) { labels[p]=label; stack.push(p); } }
                    if (cy < h-1) { const p = ci+w; if (mask[p] && !labels[p]) { labels[p]=label; stack.push(p); } }
                    if (cx > 0)   { const p = ci-1; if (mask[p] && !labels[p]) { labels[p]=label; stack.push(p); } }
                    if (cx < w-1) { const p = ci+1; if (mask[p] && !labels[p]) { labels[p]=label; stack.push(p); } }
                }
                if (size > bestSize) { bestSize = size; bestLabel = label; }
            }
        }
        const out = new Uint8Array(n);
        if (bestLabel) for (let i = 0; i < n; i++) out[i] = labels[i] === bestLabel ? 1 : 0;
        return { cleaned: out, components: label };
    }

    function cleanMask(binaryFull) {
        const t0 = performance.now();
        if (!procCanvas) {
            procCanvas = document.createElement('canvas');
            procCanvas.width = PROC_W; procCanvas.height = PROC_H;
            procCtx = procCanvas.getContext('2d', { willReadFrequently: true });
        }
        if (!upCanvas) {
            upCanvas = document.createElement('canvas');
            upCanvas.width = TARGET_W; upCanvas.height = TARGET_H;
            upCtx = upCanvas.getContext('2d', { willReadFrequently: true });
        }
        const tmpC = document.createElement('canvas');
        tmpC.width = TARGET_W; tmpC.height = TARGET_H;
        const tmpX = tmpC.getContext('2d');
        const id = tmpX.createImageData(TARGET_W, TARGET_H);
        for (let i = 0; i < binaryFull.length; i++) {
            const v = binaryFull[i] * 255;
            id.data[i*4] = v; id.data[i*4+1] = v; id.data[i*4+2] = v; id.data[i*4+3] = 255;
        }
        tmpX.putImageData(id, 0, 0);
        procCtx.drawImage(tmpC, 0, 0, PROC_W, PROC_H);
        const sd = procCtx.getImageData(0, 0, PROC_W, PROC_H);
        const sm = new Uint8Array(PROC_W * PROC_H);
        for (let i = 0; i < sm.length; i++) sm[i] = sd.data[i*4] > 128 ? 1 : 0;
        const closed = fastErode(fastDilate(sm, PROC_W, PROC_H, CLOSE_R), PROC_W, PROC_H, CLOSE_R);
        const opened = fastDilate(fastErode(closed, PROC_W, PROC_H, OPEN_R), PROC_W, PROC_H, OPEN_R);
        const { cleaned: sc, components } = keepLargest(opened, PROC_W, PROC_H);
        const cid = procCtx.createImageData(PROC_W, PROC_H);
        for (let i = 0; i < sc.length; i++) {
            const v = sc[i] * 255;
            cid.data[i*4] = v; cid.data[i*4+1] = v; cid.data[i*4+2] = v; cid.data[i*4+3] = 255;
        }
        procCtx.putImageData(cid, 0, 0);
        upCtx.drawImage(procCanvas, 0, 0, TARGET_W, TARGET_H);
        const up = upCtx.getImageData(0, 0, TARGET_W, TARGET_H);
        const result = new Uint8Array(TARGET_W * TARGET_H);
        for (let i = 0; i < result.length; i++) result[i] = up.data[i*4] > 128 ? 1 : 0;
        return { cleaned: result, components, ms: (performance.now() - t0).toFixed(1) };
    }

    // ============================================================
    // MediaPipe init
    // ============================================================
    function getExtBase() {
        try { throw new Error(); } catch (e) {
            const m = e.stack.match(/chrome-extension:\/\/([a-z]{32})\//);
            if (m) return `chrome-extension://${m[1]}/`;
        }
        for (const el of document.querySelectorAll('script[src^="chrome-extension://"]')) {
            const m = (el.src||'').match(/(chrome-extension:\/\/[a-z]{32}\/)/);
            if (m) return m[1];
        }
        const meta = document.querySelector('meta[name="extension-base"]');
        if (meta) return meta.content;
        return null;
    }

    (async () => {
        LOG('MediaPipe init: ищу base URL...');
        const base = getExtBase();
        if (!base) { ERR("❌ Нет base URL"); return; }
        LOG(`MediaPipe init: base=${base}`);
        try {
            const t0 = performance.now();
            const vision = await import(/* @vite-ignore */ `${base}mediapipe/vision_bundle.mjs`);
            LOG(`MediaPipe init: бандл OK (${(performance.now()-t0).toFixed(0)}мс)`);
            const wf = await vision.FilesetResolver.forVisionTasks(`${base}mediapipe/wasm/`);
            imageSegmenter = await vision.ImageSegmenter.createFromOptions(wf, {
                baseOptions: { modelAssetPath: `${base}mediapipe/models/selfie_segmenter.tflite`, delegate: "GPU" },
                outputCategoryMask: false, outputConfidenceMasks: true, runningMode: "VIDEO"
            });
            mpReady = true;
            LOG(`✅ MediaPipe ГОТОВ (${(performance.now()-t0).toFixed(0)}мс)`);
        } catch (e) { ERR(`❌ MediaPipe: ${e.message}`); ERR(e.stack); }
    })();

    // ============================================================
    // Обработка кадра
    // ============================================================
    function processFrame(sourceFrame) {
        if (!memoryCanvas) {
            memoryCanvas = document.createElement('canvas');
            memoryCanvas.width = TARGET_W; memoryCanvas.height = TARGET_H;
            ctx = memoryCanvas.getContext('2d', { willReadFrequently: true });
        }

        const active = window.__fadeCamActive;
        const mode = window.__fadeCamMode || 'none';

        if (!active) {
            if (sourceFrame) ctx.drawImage(sourceFrame, 0, 0, TARGET_W, TARGET_H);
            else { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, TARGET_W, TARGET_H); }
            return new VideoFrame(memoryCanvas, {
                timestamp: sourceFrame ? sourceFrame.timestamp : performance.now() * 1000,
                duration: sourceFrame ? (sourceFrame.duration || 40000) : 40000
            });
        }

        frameCount++;

        if (mode === 'video' && customVideoEl && customVideoEl.readyState >= 2) {
            ctx.drawImage(customVideoEl, 0, 0, TARGET_W, TARGET_H);
            return new VideoFrame(memoryCanvas, {
                timestamp: sourceFrame ? sourceFrame.timestamp : performance.now() * 1000,
                duration: sourceFrame ? (sourceFrame.duration || 40000) : 40000
            });
        }

        if (!mpReady || !sourceFrame) {
            ctx.fillStyle = "#FFF";
            ctx.fillRect(0, 0, TARGET_W, TARGET_H);
            return new VideoFrame(memoryCanvas, {
                timestamp: sourceFrame ? sourceFrame.timestamp : performance.now() * 1000,
                duration: sourceFrame ? (sourceFrame.duration || 40000) : 40000
            });
        }

        try {
            if (!maskCanvas) {
                maskCanvas = document.createElement('canvas');
                maskCanvas.width = TARGET_W; maskCanvas.height = TARGET_H;
                maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
            }
            maskCtx.drawImage(sourceFrame, 0, 0, TARGET_W, TARGET_H);

            if (mode === 'bg' && customBgImage && customBgImage.complete) {
                ctx.drawImage(customBgImage, 0, 0, TARGET_W, TARGET_H);
            } else {
                ctx.fillStyle = "#FFF";
                ctx.fillRect(0, 0, TARGET_W, TARGET_H);
            }

            const result = imageSegmenter.segmentForVideo(maskCanvas, performance.now());

            if (result.confidenceMasks?.length > 0) {
                const mpMask = result.confidenceMasks[0];
                let fd = null;
                try { fd = mpMask.getAsFloat32Array(); } catch(e) {}
                if (!fd) try {
                    const u = mpMask.getAsUint8Array();
                    if (u) { fd = new Float32Array(u.length); for (let i=0;i<u.length;i++) fd[i]=u[i]/255; }
                } catch(e) {}

                if (fd && fd.length === TARGET_W * TARGET_H) {
                    if (prevFloatMask) {
                        for (let i = 0; i < fd.length; i++)
                            fd[i] = EMA_ALPHA * fd[i] + (1 - EMA_ALPHA) * prevFloatMask[i];
                    } else {
                        prevFloatMask = new Float32Array(fd.length);
                    }
                    prevFloatMask.set(fd);

                    const bin = new Uint8Array(fd.length);
                    for (let i = 0; i < fd.length; i++) bin[i] = fd[i] > BIN_THRESHOLD ? 1 : 0;

                    const { cleaned, components, ms } = cleanMask(bin);

                    const src = maskCtx.getImageData(0, 0, TARGET_W, TARGET_H);
                    const out = ctx.getImageData(0, 0, TARGET_W, TARGET_H);
                    const s = src.data, o = out.data;
                    let px = 0;
                    for (let i = 0; i < cleaned.length; i++) {
                        if (cleaned[i]) {
                            const p = i * 4;
                            o[p] = s[p]; o[p+1] = s[p+1]; o[p+2] = s[p+2]; o[p+3] = 255;
                            px++;
                        }
                    }
                    ctx.putImageData(out, 0, 0);

                    segSuccessCount++;
                    if (segSuccessCount % 100 === 1)
                        LOG(`✅ #${frameCount} mode:${mode} px:${px} comp:${components}→1 clean:${ms}мс`);
                }
                mpMask.close();
            }
            result.close();
        } catch (e) {
            segErrorCount++;
            if (segErrorCount <= 3 || segErrorCount % 100 === 0) ERR(`❌ #${frameCount}: ${e.message}`);
        }

        return new VideoFrame(memoryCanvas, {
            timestamp: sourceFrame.timestamp,
            duration: sourceFrame.duration || 40000
        });
    }

    // ============================================================
    // Прокси getUserMedia
    // ============================================================
    const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let gumCount = 0, cachedStream = null, lastConstraintsHash = null;
    let trackGenerator = null, trackWriter = null, readerRunning = false;

    // Функция очистки старого пайплайна
    function cleanupPipeline(reason) {
        LOG(`  🧹 Очистка пайплайна: ${reason || 'без причины'}`);
        readerRunning = false;
        
        if (trackWriter) {
            try { trackWriter.releaseLock(); } catch(e) {}
            trackWriter = null;
        }
        
        if (cachedStream) {
            cachedStream.getTracks().forEach(t => {
                try { t.stop(); } catch(e) {}
            });
            cachedStream = null;
        }
        
        trackGenerator = null;
        lastConstraintsHash = null;
    }
    
    // Хэш для constraints
    function hashConstraints(c) {
        return JSON.stringify(c);
    }

    const fakeGUM = async function(constraints) {
        gumCount++;
        const constraintsHash = hashConstraints(constraints);
        LOG(`📷 GUM #${gumCount}: active=${window.__fadeCamActive}, mode=${window.__fadeCamMode}`);
        LOG(`  constraints hash: ${constraintsHash.substring(0, 80)}...`);
        
        if (!constraints?.video) {
            LOG(`  ⚠️ Нет видео в constraints, возвращаю оригинальный GUM`);
            return realGUM(constraints);
        }

        // СБРОС КЭША если:
        // 1. Поток неактивен
        // 2. Constraints изменились
        // 3. TrackGenerator больше не live
        const shouldReset = !cachedStream || 
                           !cachedStream.active || 
                           constraintsHash !== lastConstraintsHash ||
                           (trackGenerator && trackGenerator.readyState !== 'live');
        
        if (shouldReset && cachedStream) {
            WARN(`  🔄 Сброс кэша: active=${cachedStream?.active}, constraintsChanged=${constraintsHash !== lastConstraintsHash}, tgReady=${trackGenerator?.readyState}`);
            cleanupPipeline('изменение условий');
        }
        
        lastConstraintsHash = constraintsHash;

        if (cachedStream?.active && trackGenerator?.readyState === 'live') {
            LOG(`  ♻️ возвращаю кэш (active=${cachedStream.active}, tg=${trackGenerator.readyState})`);
            return cachedStream;
        }

        const soft = JSON.parse(JSON.stringify(constraints));
        if (typeof soft.video === 'object') {
            const v = soft.video;
            if (v.deviceId?.exact) v.deviceId = { ideal: v.deviceId.exact };
            if (v.width?.exact) v.width = { ideal: v.width.exact };
            if (v.height?.exact) v.height = { ideal: v.height.exact };
            if (v.frameRate?.exact) v.frameRate = { ideal: v.frameRate.exact };
        }

        let stream = null;
        try { stream = await realGUM(soft); LOG(`  ✅ реальный поток получен`); }
        catch(e) { 
            WARN(`  мягкие constraints не помогли: ${e.message}`);
            try { stream = await realGUM({ video: true, audio: !!constraints.audio }); LOG(`  ✅ минимум OK`); } 
            catch(e2) { ERR(`  ❌ ${e2.message}`); stream = null; } 
        }

        const tg = new MediaStreamTrackGenerator({ kind: "video" });
        trackGenerator = tg;  // Сохраняем ссылку глобально
        const wr = tg.writable.getWriter();
        trackWriter = wr;  // Сохраняем ссылку глобально
        let running = true, autoTs = 0, frames = 0;

        if (stream?.getVideoTracks().length) {
            const tp = new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0] });
            const rd = tp.readable.getReader();
            readerRunning = true;
            (async () => {
                try {
                    while (running && tg.readyState === 'live' && readerRunning) {
                        const { value: f, done } = await rd.read();
                        if (done) break;
                        const outputFrame = processFrame(f);
                        f.close();
                        if (tg.readyState !== 'live') { outputFrame.close(); break; }
                        try {
                            await wr.write(outputFrame);
                        } catch (writeErr) {
                            WARN(`  ⚠️ Ошибка записи кадра: ${writeErr.message}`);
                            outputFrame.close();
                            running = false;
                            break;
                        }
                        if (++frames % 300 === 1) LOG(`🎞️ ${frames} mode:${window.__fadeCamMode} ok:${segSuccessCount} err:${segErrorCount}`);
                    }
                } catch(e) { ERR(`Конвейер: ${e.message}`); running = false; }
                finally { 
                    try { rd.releaseLock(); } catch(e) {} 
                    LOG(`  🏁 Reader завершен`);
                }
            })();
        } else {
            WARN(`  ⚠️ Нет видеотреков в потоке от realGUM`);
            (async () => {
                try {
                    while (running && tg.readyState === 'live' && readerRunning) {
                        const f = processFrame(null);
                        f.timestamp = autoTs; autoTs += 40000;
                        try { await wr.write(f); } catch(e) { f.close(); running = false; break; }
                        await new Promise(r => setTimeout(r, 40));
                    }
                } catch(e) { ERR(`Авто: ${e.message}`); running = false; }
            })();
        }

        tg.onended = () => { 
            WARN(`  🛑 TrackGenerator onended`);
            running = false; 
            readerRunning = false;
            try { wr.releaseLock(); } catch(e) {} 
            cachedStream = null; 
            trackGenerator = null;
            trackWriter = null;
        };
        const fs = new MediaStream([tg]);
        if (stream) stream.getAudioTracks().forEach(t => fs.addTrack(t));
        cachedStream = fs;
        LOG(`  ✅ возвращаю фейковый поток`);
        return fs;
    };

    Object.setPrototypeOf(fakeGUM, Object.getPrototypeOf(navigator.mediaDevices.getUserMedia));
    Object.defineProperty(fakeGUM, 'name', { value: 'getUserMedia', configurable: true });
    try {
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: fakeGUM, writable: true, configurable: true });
        Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: fakeGUM, writable: true, configurable: true });
        WARN("✅ Прокси РАЗВЕРНУТ");
    } catch (e) { ERR("❌ Прокси:", e.message); }

    LOG('=== content.js завершил инициализацию ===');
})();