// ============================================================
// DEBUG LOG — отображается прямо в popup
// ============================================================
const DEBUG_LOG_ENABLED = true;
const debugLogEl = document.getElementById('debug-log');

function debugLog(msg, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('ru-RU', { hour12: false, fractionalSecondDigits: 3 });
    const prefix = type === 'error' ? '❌' : type === 'warn' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️';
    const line = `[${timestamp}] ${prefix} ${msg}`;
    console.log(`[POPUP] ${line}`);
    if (DEBUG_LOG_ENABLED && debugLogEl) {
        const div = document.createElement('div');
        div.textContent = line;
        if (type === 'error') div.style.color = '#f66';
        else if (type === 'warn') div.style.color = '#fc0';
        else if (type === 'success') div.style.color = '#6f6';
        debugLogEl.appendChild(div);
        debugLogEl.scrollTop = debugLogEl.scrollHeight;
        // Лимит 50 строк
        while (debugLogEl.children.length > 50) debugLogEl.removeChild(debugLogEl.firstChild);
    }
}

// ============================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    debugLog('DOMContentLoaded fired');

    const btn = document.getElementById('activate-btn');
    const statusDiv = document.getElementById('status');
    const modesSection = document.getElementById('modes-section');
    
    const videoFileInput = document.getElementById('video-file');
    const videoFileName = document.getElementById('video-file-name');
    const useVideoBtn = document.getElementById('use-video-btn');
    const clearVideoBtn = document.getElementById('clear-video-btn');
    
    const bgFileInput = document.getElementById('bg-file');
    const bgFileName = document.getElementById('bg-file-name');
    const useBgBtn = document.getElementById('use-bg-btn');
    const clearBgBtn = document.getElementById('clear-bg-btn');

    debugLog('Все DOM элементы получены');

    // ============================================================
    // Получение текущей вкладки
    // ============================================================
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    debugLog(`tabs.query вернул ${tabs.length} вкладок`);
    
    if (!tabs || tabs.length === 0) {
        debugLog('ОШИБКА: нет активной вкладки!', 'error');
        return;
    }
    
    const tab = tabs[0];
    debugLog(`Активная вкладка: id=${tab.id}, url=${tab.url}`);
    
    if (!tab.url) {
        debugLog('ОШИБКА: у вкладки нет url (chrome:// страница?)', 'error');
        statusDiv.innerText = "Не работает на chrome:// страницах";
        return;
    }

    // ============================================================
    // Получение всех фреймов вкладки (для отладки iframe проблемы)
    // ============================================================
    try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
        debugLog(`Фреймов в вкладке: ${frames ? frames.length : 0}`);
        if (frames) {
            frames.forEach((f, i) => {
                debugLog(`  frame[${i}]: id=${f.frameId}, url=${f.url.substring(0, 80)}${f.url.length > 80 ? '...' : ''}`);
            });
        }
    } catch (e) {
        debugLog(`webNavigation.getAllFrames ошибка (нужен permission): ${e.message}`, 'warn');
    }

    const domain = new URL(tab.url).hostname;
    debugLog(`Домен: ${domain}`);

    const KEY_ENABLED = domain;
    const KEY_MODE = `${domain}_mode`;
    const KEY_VIDEO = `${domain}_video`;
    const KEY_BG = `${domain}_bg`;
    const MAX_FILE_SIZE = 5 * 1024 * 1024;

    let isEnabled = false;
    let currentMode = 'none';
    let hasVideo = false;
    let hasBg = false;
    let videoData = null;
    let bgData = null;

    // ============================================================
    // Загрузка состояния
    // ============================================================
    async function loadState() {
        debugLog('loadState: читаю chrome.storage.local...');
        const data = await chrome.storage.local.get([KEY_ENABLED, KEY_MODE, KEY_VIDEO, KEY_BG]);
        debugLog(`loadState: получено ключей=${Object.keys(data).length}`);
        isEnabled = !!data[KEY_ENABLED];
        currentMode = data[KEY_MODE] || 'none';
        videoData = data[KEY_VIDEO] || null;
        bgData = data[KEY_BG] || null;
        hasVideo = !!videoData;
        hasBg = !!bgData;
        debugLog(`loadState: enabled=${isEnabled}, mode=${currentMode}, hasVideo=${hasVideo}, hasBg=${hasBg}`);
    }

    // ============================================================
    //BroadcastChannel — работает между всеми фреймами одного origin
    // ============================================================
    let broadcastChannel = null;
    try {
        broadcastChannel = new BroadcastChannel('fade_cam_control');
        debugLog('BroadcastChannel создан успешно');
        broadcastChannel.onmessage = (event) => {
            debugLog(`BroadcastChannel RX: ${JSON.stringify(event.data)}`);
        };
    } catch (e) {
        debugLog(`BroadcastChannel создать не удалось: ${e.message}`, 'warn');
    }

    // ============================================================
    // Отправка команды через ВСЕ доступные каналы
    // ============================================================
    async function sendToggle() {
        debugLog(`sendToggle: enabled=${isEnabled}, mode=${currentMode}, tabId=${tab.id}`);

        // ===== Канал 1: chrome.scripting.executeScript =====
        if (!chrome.scripting) {
            debugLog("chrome.scripting НЕДОСТУПЕН! Проверьте permissions в manifest.json", 'error');
        } else {
            debugLog('Попытка 1: chrome.scripting.executeScript (world: MAIN)...');
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    world: 'MAIN',
                    func: (enabled, mode, timestamp) => {
                        // ЭТОТ КОД ВЫПОЛНЯЕТСЯ В MAIN WORLD СТРАНИЦЫ
                        const logPrefix = `[EXEC_MAIN ${window.location.href.substring(0, 40)}]`;
                        console.log(`${logPrefix} Получено: enabled=${enabled}, mode=${mode}, sent=${timestamp}`);
                        console.log(`${logPrefix} До: __fadeCamActive=${window.__fadeCamActive}, __fadeCamMode=${window.__fadeCamMode}`);
                        
                        window.__fadeCamActive = enabled;
                        window.__fadeCamMode = mode;
                        
                        console.log(`${logPrefix} После: __fadeCamActive=${window.__fadeCamActive}, __fadeCamMode=${window.__fadeCamMode}`);
                        
                        try {
                            window.dispatchEvent(new CustomEvent('FADE_CAM_TOGGLE', { 
                                detail: { enabled: enabled, mode: mode } 
                            }));
                            console.log(`${logPrefix} CustomEvent FADE_CAM_TOGGLE отправлен`);
                        } catch (e) {
                            console.error(`${logPrefix} Ошибка CustomEvent:`, e);
                        }
                        
                        try {
                            const bc = new BroadcastChannel('fade_cam_control');
                            bc.postMessage({ type: 'TOGGLE', enabled, mode });
                            bc.close();
                            console.log(`${logPrefix} BroadcastChannel postMessage отправлен`);
                        } catch (e) {
                            console.error(`${logPrefix} BroadcastChannel ошибка:`, e);
                        }
                        
                        return { ok: true, wasActive: window.__fadeCamActive, frameUrl: window.location.href };
                    },
                    args: [isEnabled, currentMode, Date.now()]
                });
                debugLog(`executeScript вернул ${results.length} результатов:`, 'success');
                results.forEach((r, i) => {
                    const val = r.result || {};
                    debugLog(`  result[${i}]: frameId=${r.frameId}, ok=${val.ok}, wasActive=${val.wasActive}, url=${(val.frameUrl||'').substring(0,50)}`);
                });
            } catch (err) {
                debugLog(`executeScript ОШИБКА: ${err.message}`, 'error');
                debugLog(`Stack: ${err.stack}`, 'error');
            }
        }

        // ===== Канал 2: BroadcastChannel (для iframe communication) =====
        if (broadcastChannel) {
            debugLog('Попытка 2: BroadcastChannel.postMessage...');
            try {
                broadcastChannel.postMessage({ 
                    type: 'TOGGLE', 
                    enabled: isEnabled, 
                    mode: currentMode,
                    timestamp: Date.now()
                });
                debugLog('BroadcastChannel postMessage отправлен', 'success');
            } catch (e) {
                debugLog(`BroadcastChannel ошибка: ${e.message}`, 'error');
            }
        }
    }

    async function sendMedia(mediaType, data) {
        debugLog(`sendMedia: type=${mediaType}, dataSize=${data ? data.length : 0}`);

        if (chrome.scripting) {
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    world: 'MAIN',
                    func: (type, payload, timestamp) => {
                        console.log(`[EXEC_MAIN ${window.location.href.substring(0,40)}] SET_MEDIA: type=${type}, size=${payload ? payload.length : 0}`);
                        window.dispatchEvent(new CustomEvent('FADE_CAM_SET_MEDIA', { 
                            detail: { type: type, data: payload } 
                        }));
                        try {
                            const bc = new BroadcastChannel('fade_cam_control');
                            bc.postMessage({ type: 'SET_MEDIA', mediaType: type, data: payload });
                            bc.close();
                        } catch (e) {}
                        return { ok: true };
                    },
                    args: [mediaType, data, Date.now()]
                });
                debugLog(`sendMedia executeScript: ${results.length} результатов`, 'success');
            } catch (err) {
                debugLog(`sendMedia executeScript ошибка: ${err.message}`, 'error');
            }
        }

        if (broadcastChannel && data) {
            try {
                broadcastChannel.postMessage({ 
                    type: 'SET_MEDIA', 
                    mediaType: mediaType, 
                    data: data,
                    timestamp: Date.now()
                });
                debugLog('sendMedia BroadcastChannel отправлен', 'success');
            } catch (e) {
                debugLog(`sendMedia BroadcastChannel ошибка: ${e.message}`, 'error');
            }
        }
    }

    // ============================================================
    // UI обновление
    // ============================================================
    function updateUI() {
        debugLog(`updateUI: enabled=${isEnabled}, mode=${currentMode}`);
        if (isEnabled) {
            btn.innerText = "Выключить подмену";
            btn.className = "btn-on";
            modesSection.classList.remove('disabled');
        } else {
            btn.innerText = "Включить подмену";
            btn.className = "btn-off";
            modesSection.classList.add('disabled');
        }

        videoFileName.textContent = hasVideo ? '✓ Файл загружен' : '';
        bgFileName.textContent = hasBg ? '✓ Файл загружен' : '';
        useVideoBtn.disabled = !hasVideo || !isEnabled;
        useBgBtn.disabled = !hasBg || !isEnabled;

        if (!isEnabled) {
            statusDiv.innerText = "Трансляция реальной камеры";
            statusDiv.style.color = "#666";
        } else if (currentMode === 'video') {
            statusDiv.innerText = "📹 Режим: Видео/изображение";
            statusDiv.style.color = "#4a90e2";
        } else if (currentMode === 'bg') {
            statusDiv.innerText = "🖼️ Режим: Камера + фон";
            statusDiv.style.color = "#9b59b6";
        } else {
            statusDiv.innerText = "👤 Режим: Силуэт на белом";
            statusDiv.style.color = "green";
        }
    }

    // ============================================================
    // Обработчики кнопок
    // ============================================================
    btn.addEventListener('click', async () => {
        debugLog(`[CLICK] activate-btn: текущий isEnabled=${isEnabled}, переключаю...`);
        isEnabled = !isEnabled;
        debugLog(`[CLICK] Новый isEnabled=${isEnabled}`);
        
        if (isEnabled) {
            await chrome.storage.local.set({ [KEY_ENABLED]: true });
            debugLog(`[CLICK] Сохранил ${KEY_ENABLED}=true`);
        } else {
            await chrome.storage.local.remove(KEY_ENABLED);
            currentMode = 'none';
            await chrome.storage.local.set({ [KEY_MODE]: 'none' });
            debugLog(`[CLICK] Удалил ${KEY_ENABLED}, mode=none`);
        }
        updateUI();
        await sendToggle();
    });

    videoFileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) { debugLog('video-file: файл не выбран'); return; }
        debugLog(`video-file: выбран ${file.name}, размер=${(file.size/1024).toFixed(1)}KB, тип=${file.type}`);
        if (file.size > MAX_FILE_SIZE) {
            debugLog(`video-file: СЛИШКОМ БОЛЬШОЙ! Макс 5MB`, 'error');
            alert(`Файл слишком большой. Макс: 5MB`);
            e.target.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = async (event) => {
            videoData = event.target.result;
            await chrome.storage.local.set({ [KEY_VIDEO]: videoData });
            hasVideo = true;
            debugLog(`video-file: загружен в storage, размер base64=${videoData.length}`, 'success');
            updateUI();
        };
        reader.onerror = () => debugLog('video-file: ошибка чтения', 'error');
        reader.readAsDataURL(file);
    });

    useVideoBtn.addEventListener('click', async () => {
        debugLog(`[CLICK] use-video-btn: hasVideo=${hasVideo}`);
        if (!hasVideo) { debugLog('use-video: нет видео!', 'warn'); return; }
        currentMode = 'video';
        await chrome.storage.local.set({ [KEY_MODE]: 'video' });
        updateUI();
        await sendToggle();
        setTimeout(() => sendMedia('video', videoData), 150);
    });

    clearVideoBtn.addEventListener('click', async () => {
        debugLog('[CLICK] clear-video-btn');
        await chrome.storage.local.remove(KEY_VIDEO);
        hasVideo = false; videoData = null;
        if (currentMode === 'video') {
            currentMode = 'none';
            await chrome.storage.local.set({ [KEY_MODE]: 'none' });
        }
        updateUI();
        await sendToggle();
        sendMedia('clear_video', null);
    });

    bgFileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) { debugLog('bg-file: файл не выбран'); return; }
        debugLog(`bg-file: выбран ${file.name}, размер=${(file.size/1024).toFixed(1)}KB, тип=${file.type}`);
        if (file.size > MAX_FILE_SIZE) {
            debugLog(`bg-file: СЛИШКОМ БОЛЬШОЙ!`, 'error');
            alert(`Файл слишком большой. Макс: 5MB`);
            e.target.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = async (event) => {
            bgData = event.target.result;
            await chrome.storage.local.set({ [KEY_BG]: bgData });
            hasBg = true;
            debugLog(`bg-file: загружен в storage, размер base64=${bgData.length}`, 'success');
            updateUI();
        };
        reader.onerror = () => debugLog('bg-file: ошибка чтения', 'error');
        reader.readAsDataURL(file);
    });

    useBgBtn.addEventListener('click', async () => {
        debugLog(`[CLICK] use-bg-btn: hasBg=${hasBg}`);
        if (!hasBg) { debugLog('use-bg: нет фона!', 'warn'); return; }
        currentMode = 'bg';
        await chrome.storage.local.set({ [KEY_MODE]: 'bg' });
        updateUI();
        await sendToggle();
        setTimeout(() => sendMedia('bg', bgData), 150);
    });

    clearBgBtn.addEventListener('click', async () => {
        debugLog('[CLICK] clear-bg-btn');
        await chrome.storage.local.remove(KEY_BG);
        hasBg = false; bgData = null;
        if (currentMode === 'bg') {
            currentMode = 'none';
            await chrome.storage.local.set({ [KEY_MODE]: 'none' });
        }
        updateUI();
        await sendToggle();
        sendMedia('clear_bg', null);
    });

    // ============================================================
    // Старт
    // ============================================================
    debugLog('Вызываю loadState()...');
    await loadState();
    debugLog('loadState() завершен, вызываю updateUI()...');
    updateUI();
    
    if (isEnabled) {
        debugLog('Подмена была активна — синхронизирую с content...');
        await sendToggle();
        if (currentMode === 'video' && videoData) setTimeout(() => sendMedia('video', videoData), 200);
        if (currentMode === 'bg' && bgData) setTimeout(() => sendMedia('bg', bgData), 200);
    }

    debugLog('=== POPUP ГОТОВ ===', 'success');
});