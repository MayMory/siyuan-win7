// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

const {
    net,
    app,
    BrowserWindow,
    shell,
    Menu,
    MenuItem,
    screen,
    ipcMain,
    globalShortcut,
    Tray,
    dialog,
    systemPreferences,
    powerMonitor
} = require("electron");
const path = require("path");
const fs = require("fs");
const gNet = require("net");
const remote = require("@electron/remote/main");

process.noAsar = true;
const appDir = path.dirname(app.getAppPath());
const isDevEnv = process.env.NODE_ENV === "development";
const appVer = app.getVersion();
const confDir = path.join(app.getPath("home"), ".config", "siyuan");
const windowStatePath = path.join(confDir, "windowState.json");
const remoteServerConfigPath = path.join(confDir, "remote-server.json");
let bootWindow;
let latestActiveWindow;
let firstOpen = false;
let workspaces = []; // workspaceDir, id, browserWindow, tray, hideShortcut
let resetWindowStateOnRestart = false;
// 远程服务器配置
let remoteServerConfig = {
    host: "192.168.2.21",
    port: 50080
};

remote.initialize();

app.setPath("userData", app.getPath("userData") + "-Electron");
fs.rmSync(app.getPath("appData") + "/" + app.name, {recursive: true, force: true});

// 初始化配置目录
try {
    firstOpen = !fs.existsSync(path.join(confDir, "workspace.json"));
    if (!fs.existsSync(confDir)) {
        fs.mkdirSync(confDir, {mode: 0o755, recursive: true});
    }
} catch (e) {
    console.error(e);
    require("electron").dialog.showErrorBox("创建配置目录失败 Failed to create config directory", "思源需要在用户家目录下创建配置文件夹（~/.config/siyuan），请确保该路径具有写入权限。\n\nSiYuan needs to create a configuration folder (~/.config/siyuan) in the user's home directory. Please make sure that the path has write permissions.");
    app.exit();
}

// 加载远程服务器配置
const loadRemoteServerConfig = () => {
    try {
        if (fs.existsSync(remoteServerConfigPath)) {
            const config = JSON.parse(fs.readFileSync(remoteServerConfigPath, "utf8"));
            if (config.host && config.port) {
                remoteServerConfig = config;
            }
        }
    } catch (e) {
        console.error("加载远程服务器配置失败:", e);
        // 使用默认配置并保存
        saveRemoteServerConfig();
    }
};

// 保存远程服务器配置
const saveRemoteServerConfig = () => {
    try {
        fs.writeFileSync(remoteServerConfigPath, JSON.stringify(remoteServerConfig, null, 2));
    } catch (e) {
        console.error("保存远程服务器配置失败:", e);
        dialog.showErrorBox("保存失败", "无法保存远程服务器配置，请检查目录权限");
    }
};

// 获取远程服务器地址
const getRemoteServer = () => {
    return `http://${remoteServerConfig.host}:${remoteServerConfig.port}`;
};

const windowNavigate = (currentWindow, windowType) => {
    currentWindow.webContents.on("will-navigate", (event) => {
        const url = event.url;
        if (url.startsWith(getRemoteServer())) {
            try {
                const pathname = new URL(url).pathname;
                if (pathname === "/check-auth" || pathname === "/") {
                    return;
                }
                if (pathname === "/stage/build/app/" && windowType === "app") {
                    return;
                }
                if (pathname === "/stage/build/app/window.html" && windowType === "window") {
                    return;
                }
                if (pathname.startsWith("/export/temp/") && windowType === "export") {
                    return;
                }
            } catch (e) {
                return;
            }
        }
        event.preventDefault();
        shell.openExternal(url);
    });
};

const setProxy = (proxyURL, webContents) => {
    if (proxyURL.startsWith("://")) {
        console.log("network proxy [system]");
        return webContents.session.setProxy({mode: "system"});
    }
    console.log("network proxy [" + proxyURL + "]");
    return webContents.session.setProxy({proxyRules: proxyURL});
};

const hotKey2Electron = (key) => {
    if (!key) {
        return key;
    }
    let electronKey = "";
    if (key.indexOf("⌘") > -1) {
        electronKey += "CommandOrControl+";
    }
    if (key.indexOf("⌃") > -1) {
        electronKey += "Control+";
    }
    if (key.indexOf("⇧") > -1) {
        electronKey += "Shift+";
    }
    if (key.indexOf("⌥") > -1) {
        electronKey += "Alt+";
    }
    return electronKey + key.replace("⌘", "").replace("⇧", "").replace("⌥", "").replace("⌃", "");
};

/**
 * 将 RFC 5646 格式的语言标签解析为应用支持的语言代码
 * https://www.rfc-editor.org/info/rfc5646
 * @param {string[]} languageTags - 语言标签数组（如 ["zh-Hans-CN", "en-US"]）
 * @returns {string} 应用支持的语言代码
 */
const resolveAppLanguage = (languageTags) => {
    if (!languageTags || languageTags.length === 0) {
        return "en_US";
    }

    const tag = languageTags[0].toLowerCase();
    const parts = tag.replace(/_/g, "-").split("-");
    const language = parts[0];

    if (language === "zh") {
        if (tag.includes("hant")) {
            return "zh_CHT";
        }
        if (tag.includes("hans") || tag.includes("cn") || tag.includes("sg")) {
            return "zh_CN";
        }
        if (tag.includes("tw") || tag.includes("hk") || tag.includes("mo")) {
            return "zh_CHT";
        }
        return "zh_CN";
    }

    const languageMapping = {
        "en": "en_US",
        "ar": "ar_SA",
        "de": "de_DE",
        "es": "es_ES",
        "fr": "fr_FR",
        "he": "he_IL",
        "it": "it_IT",
        "ja": "ja_JP",
        "ko": "ko_KR",
        "pl": "pl_PL",
        "pt": "pt_BR",
        "ru": "ru_RU",
        "tr": "tr_TR"
    };

    return languageMapping[language] || "en_US";
};

const exitApp = (errorWindowId) => {
    let tray;
    let mainWindow;

    BrowserWindow.getAllWindows().forEach((item) => {
        try {
            const currentURL = new URL(item.getURL());
            const hasMain = workspaces.find((workspaceItem) => {
                if (workspaceItem.browserWindow.id === item.id) {
                    mainWindow = item;
                    return true;
                }
            });
            if (!hasMain) {
                item.destroy();
            }
        } catch (e) {
            // load file is not a url
        }
    });
    workspaces.find((item, index) => {
        if (mainWindow && mainWindow.id === item.browserWindow.id) {
            if (workspaces.length > 1) {
                item.browserWindow.destroy();
            }
            workspaces.splice(index, 1);
            tray = item.tray;
            return true;
        }
    });
    if (tray && ("win32" === process.platform || "linux" === process.platform)) {
        tray.destroy();
    }
    if (workspaces.length === 0 && mainWindow) {
        try {
            if (resetWindowStateOnRestart) {
                fs.writeFileSync(windowStatePath, "{}");
            } else {
                const bounds = mainWindow.getBounds();
                fs.writeFileSync(windowStatePath, JSON.stringify({
                    isMaximized: mainWindow.isMaximized(),
                    fullscreen: mainWindow.isFullScreen(),
                    isDevToolsOpened: mainWindow.webContents.isDevToolsOpened(),
                    x: bounds.x,
                    y: bounds.y,
                    width: bounds.width,
                    height: bounds.height,
                }));
            }
        } catch (e) {
            writeLog(e);
        }

        if (errorWindowId) {
            BrowserWindow.getAllWindows().forEach((item) => {
                if (errorWindowId !== item.id) {
                    item.destroy();
                }
            });
        } else {
            app.exit();
        }
        globalShortcut.unregisterAll();
        writeLog("exited ui");
    }
};

const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

const showErrorWindow = (titleZh, titleEn, content, emoji = "⚠️") => {
    let errorHTMLPath = path.join(appDir, "app", "electron", "error.html");
    if (isDevEnv) {
        errorHTMLPath = path.join(appDir, "electron", "error.html");
    }
    const errWindow = new BrowserWindow({
        width: Math.floor(screen.getPrimaryDisplay().size.width * 0.5),
        height: Math.floor(screen.getPrimaryDisplay().workAreaSize.height * 0.8),
        frame: "darwin" === process.platform,
        titleBarStyle: "hidden",
        fullscreenable: false,
        icon: path.join(appDir, "stage", "icon-large.png"),
        transparent: "darwin" === process.platform,
        webPreferences: {
            nodeIntegration: true, webviewTag: true, webSecurity: false, contextIsolation: false,
        },
    });
    errWindow.loadFile(errorHTMLPath, {
        query: {
            home: app.getPath("home"),
            v: appVer,
            title: `<h2>${titleZh}</h2><h2>${titleEn}</h2>`,
            emoji,
            content,
            icon: path.join(appDir, "stage", "icon-large.png"),
        },
    });
    errWindow.show();
    return errWindow.id;
};

// 创建远程服务器配置窗口
const createConfigWindow = () => {
    const configWindow = new BrowserWindow({
        width: 400,
        height: 300,
        resizable: false,
        frame: true,
        title: "远程服务器配置",
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false
        }
    });

    // 内嵌配置页面
    const configHTML = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>远程服务器配置</title>
            <style>
                body { padding: 20px; font-family: Arial; }
                .form-group { margin-bottom: 15px; }
                label { display: block; margin-bottom: 5px; }
                input { width: 90%; padding: 8px; }
                .btn-group { margin-top: 20px; }
                button { padding: 8px 15px; margin-right: 10px; cursor: pointer; }
                #status { margin-top: 15px; color: green; }
                .error { color: red; }
            </style>
        </head>
        <body>
            <div class="form-group">
                <label>服务器地址:</label>
                <input type="text" id="host" value="${remoteServerConfig.host}">
            </div>
            <div class="form-group">
                <label>服务器端口:</label>
                <input type="number" id="port" value="${remoteServerConfig.port}">
            </div>
            <div class="btn-group">
                <button id="testBtn">测试连接</button>
                <button id="saveBtn">保存配置</button>
            </div>
            <div id="status"></div>

            <script>
                const { ipcRenderer } = require('electron');
                
                // 测试连接
                document.getElementById('testBtn').addEventListener('click', async () => {
                    const host = document.getElementById('host').value;
                    const port = document.getElementById('port').value;
                    const status = document.getElementById('status');
                    
                    if (!host || !port) {
                        status.textContent = '请填写完整的服务器地址和端口';
                        status.className = 'error';
                        return;
                    }
                    
                    status.textContent = '正在测试连接...';
                    status.className = '';
                    
                    try {
                        const response = await ipcRenderer.invoke('test-remote-connection', { host, port });
                        status.textContent = \`连接成功，服务端版本: \${response.version}\`;
                        status.className = '';
                    } catch (e) {
                        status.textContent = \`连接失败: \${e.message}\`;
                        status.className = 'error';
                    }
                });
                
                // 保存配置
                document.getElementById('saveBtn').addEventListener('click', () => {
                    const host = document.getElementById('host').value;
                    const port = document.getElementById('port').value;
                    const status = document.getElementById('status');
                    
                    if (!host || !port) {
                        status.textContent = '请填写完整的服务器地址和端口';
                        status.className = 'error';
                        return;
                    }
                    
                    ipcRenderer.invoke('save-remote-config', { host, port })
                        .then(() => {
                            status.textContent = '配置保存成功';
                            status.className = '';
                        })
                        .catch(e => {
                            status.textContent = \`保存失败: \${e.message}\`;
                            status.className = 'error';
                        });
                });
            </script>
        </body>
        </html>
    `;

    // 加载内嵌HTML
    configWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(configHTML)}`);
    configWindow.setMenu(null);
    return configWindow;
};

const writeLog = (out) => {
    console.log(out);
    const logFile = path.join(confDir, "app.log");
    let log = "";
    const maxLogLines = 1024;
    try {
        if (fs.existsSync(logFile)) {
            log = fs.readFileSync(logFile).toString();
            let lines = log.split("\n");
            if (maxLogLines < lines.length) {
                log = lines.slice(maxLogLines / 2, maxLogLines).join("\n") + "\n";
            }
        }
        out = out.toString();
        out = new Date().toISOString().replace(/T/, " ").replace(/\..+/, "") + " " + out;
        log += out + "\n";
        fs.writeFileSync(logFile, log);
    } catch (e) {
        console.error(e);
    }
};

let openAsHidden = false;
const isOpenAsHidden = function () {
    return 1 === workspaces.length && openAsHidden;
};

const initMainWindow = () => {
    // 恢复主窗体状态
    let oldWindowState = {};
    try {
        oldWindowState = JSON.parse(fs.readFileSync(windowStatePath, "utf8"));
    } catch (e) {
        writeLog("read window state failed: " + e);
        fs.writeFileSync(windowStatePath, "{}");
    }
    let defaultWidth;
    let defaultHeight;
    let workArea;
    try {
        defaultWidth = Math.floor(screen.getPrimaryDisplay().size.width * 0.8);
        defaultHeight = Math.floor(screen.getPrimaryDisplay().workAreaSize.height * 0.8);
        workArea = screen.getPrimaryDisplay().workArea;
    } catch (e) {
        writeLog("get screen size failed: " + e);
    }
    const windowState = Object.assign({}, {
        isMaximized: false,
        fullscreen: false,
        isDevToolsOpened: false,
        x: 0,
        y: 0,
        width: defaultWidth,
        height: defaultHeight,
    }, oldWindowState);

    writeLog("window stat [x=" + windowState.x + ", y=" + windowState.y + ", width=" + windowState.width + ", height=" + windowState.height + "], " +
        "default [x=0, y=0, width=" + defaultWidth + ", height=" + defaultHeight + "], " +
        "old [x=" + oldWindowState.x + ", y=" + oldWindowState.y + ", width=" + oldWindowState.width + ", height=" + oldWindowState.height + "], " +
        "workArea [width=" + workArea.width + ", height=" + workArea.height + "]");

    let resetToCenter = false;
    let x = windowState.x;
    if (-32 < x && 0 > x) {
        x = 0;
    }
    let y = windowState.y;
    if (-32 < y && 0 > y) {
        y = 0;
    }
    if (workArea) {
        if (windowState.width > workArea.width + 32 || windowState.height > workArea.height + 32) {
            windowState.width = Math.min(defaultWidth, workArea.width);
            windowState.height = Math.min(defaultHeight, workArea.height);
            writeLog("reset window size [width=" + windowState.width + ", height=" + windowState.height + "]");
        }

        if (x >= workArea.width * 0.8 || y >= workArea.height * 0.8) {
            resetToCenter = true;
            writeLog("reset window to center cause x or y >= 80% of workArea");
        }
    }

    if (x < 0 || y < 0) {
        resetToCenter = true;
        writeLog("reset window to center cause x or y < 0");
    }

    if (windowState.width < 493) {
        windowState.width = 493;
        writeLog("reset window width [493]");
    }
    if (windowState.height < 376) {
        windowState.height = 376;
        writeLog("reset window height [376]");
    }

    // 创建主窗体
    const currentWindow = new BrowserWindow({
        show: false,
        width: windowState.width,
        height: windowState.height,
        minWidth: 493,
        minHeight: 376,
        fullscreenable: true,
        fullscreen: windowState.fullscreen,
        trafficLightPosition: {x: 8, y: 8},
        transparent: "darwin" === process.platform,
        webPreferences: {
            nodeIntegration: true,
            webviewTag: true,
            webSecurity: false,
            contextIsolation: false,
            autoplayPolicy: "user-gesture-required"
        },
        frame: "darwin" === process.platform,
        titleBarStyle: "hidden",
        icon: path.join(appDir, "stage", "icon-large.png"),
    });
    remote.enable(currentWindow.webContents);

    if (resetToCenter) {
        currentWindow.center();
    } else {
        writeLog("window position [x=" + x + ", y=" + y + "]");
        currentWindow.setPosition(x, y);
    }
    currentWindow.webContents.userAgent = "SiYuan/" + appVer + " https://b3log.org/siyuan Electron " + currentWindow.webContents.userAgent;

    // 设置代理（如果有）
    net.fetch(getRemoteServer() + "/api/system/getNetwork", {method: "POST"}).then((response) => {
        return response.json();
    }).then((response) => {
        if (response.data?.proxy) {
            const proxyURL = `${response.data.proxy.scheme}://${response.data.proxy.host}:${response.data.proxy.port}`;
            setProxy(proxyURL, currentWindow.webContents);
        }
        // 加载远程服务器主界面
        currentWindow.loadURL(`${getRemoteServer()}/stage/build/app/?v=${new Date().getTime()}`);
    }).catch(err => {
        console.error("加载远程服务器失败:", err);
        // 加载失败时显示配置窗口
        createConfigWindow();
        // 仍加载主窗口（空页面）
        currentWindow.loadURL(`${getRemoteServer()}/stage/build/app/?v=${new Date().getTime()}`);
    });

    // 发起互联网服务请求时绕过安全策略
    currentWindow.webContents.session.webRequest.onBeforeSendHeaders((details, cb) => {
        if (-1 < details.url.toLowerCase().indexOf("bili")) {
            cb({requestHeaders: details.requestHeaders});
            return;
        }

        if (-1 < details.url.toLowerCase().indexOf("youtube")) {
            details.requestHeaders["Referer"] = "https://b3log.org/siyuan/";
            cb({requestHeaders: details.requestHeaders});
            return;
        }

        for (let key in details.requestHeaders) {
            if ("referer" === key.toLowerCase()) {
                delete details.requestHeaders[key];
            }
        }
        cb({requestHeaders: details.requestHeaders});
    });
    currentWindow.webContents.session.webRequest.onHeadersReceived((details, cb) => {
        for (let key in details.responseHeaders) {
            if ("x-frame-options" === key.toLowerCase()) {
                delete details.responseHeaders[key];
            } else if ("content-security-policy" === key.toLowerCase()) {
                delete details.responseHeaders[key];
            } else if ("access-control-allow-origin" === key.toLowerCase()) {
                delete details.responseHeaders[key];
            }
        }
        cb({responseHeaders: details.responseHeaders});
    });

    currentWindow.webContents.on("did-finish-load", () => {
        let siyuanOpenURL = process.argv.find((arg) => arg.startsWith("siyuan://"));
        if (siyuanOpenURL) {
            if (currentWindow.isMinimized()) {
                currentWindow.restore();
            }
            currentWindow.show();
            setTimeout(() => {
                writeLog(siyuanOpenURL);
                currentWindow.webContents.send("siyuan-open-url", siyuanOpenURL);
            }, 2000);
        }
    });

    if (windowState.isDevToolsOpened) {
        currentWindow.webContents.openDevTools({mode: "bottom"});
    }

    // 主界面事件监听
    currentWindow.once("ready-to-show", () => {
        if (isOpenAsHidden()) {
            currentWindow.minimize();
        } else {
            currentWindow.show();
            if (windowState.isMaximized) {
                currentWindow.maximize();
            } else {
                currentWindow.unmaximize();
            }
        }
        // 移除启动窗口逻辑
    });

    // 菜单 - 新增配置服务器选项
    const productName = "SiYuan";
    const template = [{
        label: productName, submenu: [{
            label: `About ${productName}`, role: "about",
        }, {
            label: "配置远程服务器", click: () => createConfigWindow()
        }, {type: "separator"}, {role: "services"}, {type: "separator"}, {
            label: `Hide ${productName}`, role: "hide",
        }, {role: "hideOthers"}, {role: "unhide"}, {type: "separator"}, {
            label: `Quit ${productName}`, role: "quit",
        },],
    }, {
        role: "editMenu", submenu: [{role: "cut"}, {role: "copy"}, {role: "paste"}, {
            role: "pasteAndMatchStyle", accelerator: "CmdOrCtrl+Shift+C"
        }, {role: "selectAll"},],
    }, {
        role: "windowMenu",
        submenu: [{role: "minimize"}, {role: "zoom"}, {role: "togglefullscreen"}, {type: "separator"}, {role: "toggledevtools"}, {type: "separator"}, {role: "front"},],
    },];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
    
    windowNavigate(currentWindow, "app");
    currentWindow.on("close", (event) => {
        if (currentWindow && !currentWindow.isDestroyed()) {
            currentWindow.webContents.send("siyuan-save-close", false);
        }
        event.preventDefault();
    });
    workspaces.push({
        browserWindow: currentWindow,
    });
};

const showWindow = (wnd) => {
    if (!wnd || wnd.isDestroyed()) {
        return;
    }

    if (wnd.isMinimized()) {
        wnd.restore();
    }
    wnd.show();
};

app.setAsDefaultProtocolClient("siyuan");

app.commandLine.appendSwitch("disable-web-security");
app.commandLine.appendSwitch("auto-detect", "false");
app.commandLine.appendSwitch("no-proxy-server");
app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport");
app.commandLine.appendSwitch("xdg-portal-required-version", "4");

writeLog("app is packaged [" + app.isPackaged + "], command line args [" + process.argv.join(", ") + "]");
let argStart = 1;
if (!app.isPackaged) {
    argStart = 2;
}

for (let i = argStart; i < process.argv.length; i++) {
    let arg = process.argv[i];
    if (arg.startsWith("--workspace=") || arg.startsWith("--openAsHidden") || arg.startsWith("--port=") || arg.startsWith("siyuan://")) {
        if (arg.startsWith("--openAsHidden")) {
            openAsHidden = true;
            writeLog("open as hidden");
        }
        continue;
    }

    app.commandLine.appendSwitch(arg);
    writeLog("command line switch [" + arg + "]");
}

// 注册IPC通信
ipcMain.handle("test-remote-connection", async (event, config) => {
    try {
        const response = await net.fetch(`http://${config.host}:${config.port}/api/system/version`, {
            method: "POST",
            timeout: 5000
        });
        if (!response.ok) {
            throw new Error(`HTTP错误: ${response.status}`);
        }
        const data = await response.json();
        if (data.code !== 0) {
            throw new Error(data.msg || "获取版本失败");
        }
        return { version: data.data };
    } catch (e) {
        throw new Error(`无法连接到服务器: ${e.message}`);
    }
});

ipcMain.handle("save-remote-config", async (event, config) => {
    remoteServerConfig = {
        host: config.host,
        port: parseInt(config.port)
    };
    saveRemoteServerConfig();
    return { success: true };
});

app.whenReady().then(() => {
    // 加载远程服务器配置
    loadRemoteServerConfig();

    const resetTrayMenu = (tray, lang, mainWindow) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        const trayMenuTemplate = [{
            label: mainWindow.isVisible() ? lang.hideWindow : lang.showWindow, click: () => {
                showHideWindow(tray, lang, mainWindow);
            },
        }, {
            label: "配置远程服务器", click: () => createConfigWindow()
        }, {
            label: lang.officialWebsite, click: () => {
                shell.openExternal("https://b3log.org/siyuan/");
            },
        }, {
            label: lang.openSource, click: () => {
                shell.openExternal("https://github.com/siyuan-note/siyuan");
            },
        }, {
            label: lang.resetWindow, type: "checkbox", click: v => {
                resetWindowStateOnRestart = v.checked;
                mainWindow.webContents.send("siyuan-save-close", true);
            },
        }, {
            label: lang.quit, click: () => {
                mainWindow.webContents.send("siyuan-save-close", true);
            },
        },];

        if ("win32" === process.platform) {
            trayMenuTemplate.splice(2, 0, {
                label: mainWindow.isAlwaysOnTop() ? lang.cancelWindowTop : lang.setWindowTop, click: () => {
                    if (!mainWindow.isAlwaysOnTop()) {
                        mainWindow.setAlwaysOnTop(true);
                    } else {
                        mainWindow.setAlwaysOnTop(false);
                    }
                    resetTrayMenu(tray, lang, mainWindow);
                },
            });
        }
        const contextMenu = Menu.buildFromTemplate(trayMenuTemplate);
        tray.setContextMenu(contextMenu);
    };
    
    const hideWindow = (wnd) => {
        wnd.minimize();
        if ("win32" === process.platform || "linux" === process.platform) {
            wnd.hide();
        }
    };
    
    const showHideWindow = (tray, lang, mainWindow) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        if (!mainWindow.isVisible()) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.show();
        } else {
            hideWindow(mainWindow);
        }

        resetTrayMenu(tray, lang, mainWindow);
    };

    const getWindowByContentId = (id) => {
        return BrowserWindow.getAllWindows().find((win) => win.webContents.id === id);
    };
    
    ipcMain.on("siyuan-context-menu", (event, langs) => {
        const template = [new MenuItem({
            role: "undo", label: langs.undo
        }), new MenuItem({
            role: "redo", label: langs.redo
        }), {type: "separator"}, new MenuItem({
            role: "copy", label: langs.copy
        }), new MenuItem({
            role: "cut", label: langs.cut
        }), new MenuItem({
            role: "delete", label: langs.delete
        }), new MenuItem({
            role: "paste", label: langs.paste
        }), new MenuItem({
            role: "pasteAndMatchStyle", label: langs.pasteAsPlainText
        }), new MenuItem({
            role: "selectAll", label: langs.selectAll
        })];
        const menu = Menu.buildFromTemplate(template);
        menu.popup({window: BrowserWindow.fromWebContents(event.sender)});
    });
    
    ipcMain.on("siyuan-first-quit", () => {
        app.exit();
    });
    
    ipcMain.handle("siyuan-get", (event, data) => {
        if (data.cmd === "showOpenDialog") {
            return dialog.showOpenDialog(data);
        }
        if (data.cmd === "getContentsId") {
            return event.sender.id;
        }
        if (data.cmd === "availableSpellCheckerLanguages") {
            return event.sender.session.availableSpellCheckerLanguages;
        }
        if (data.cmd === "setProxy") {
            return setProxy(data.proxyURL, event.sender);
        }
        if (data.cmd === "showSaveDialog") {
            return dialog.showSaveDialog(data);
        }
        if (data.cmd === "isFullScreen") {
            const wnd = getWindowByContentId(event.sender.id);
            if (!wnd) {
                return false;
            }
            return wnd.isFullScreen();
        }
        if (data.cmd === "isMaximized") {
            const wnd = getWindowByContentId(event.sender.id);
            if (!wnd) {
                return false;
            }
            return wnd.isMaximized();
        }
        if (data.cmd === "getMicrophone") {
            return systemPreferences.getMediaAccessStatus("microphone");
        }
        if (data.cmd === "askMicrophone") {
            return systemPreferences.askForMediaAccess("microphone");
        }
        if (data.cmd === "printToPDF") {
            try {
                return getWindowByContentId(data.webContentsId).webContents.printToPDF(data.pdfOptions);
            } catch (e) {
                writeLog("printToPDF: ", e);
                throw e;
            }
        }
        if (data.cmd === "siyuan-open-file") {
            let hasMatch = false;
            BrowserWindow.getAllWindows().find(item => {
                const url = new URL(item.webContents.getURL());
                if (item.webContents.id === event.sender.id || data.port !== url.port) {
                    return;
                }
                const ids = decodeURIComponent(url.hash.substring(1)).split("\u200b");
            });
        }
    });

    const initEventId = [];
    ipcMain.on("siyuan-event", (event) => {
        if (initEventId.includes(event.sender.id)) {
            return;
        }
        initEventId.push(event.sender.id);
        const currentWindow = getWindowByContentId(event.sender.id);
        if (!currentWindow) {
            return;
        }
        latestActiveWindow = currentWindow;
        currentWindow.on("focus", () => {
            event.sender.send("siyuan-event", "focus");
            latestActiveWindow = currentWindow;
        });
        currentWindow.on("blur", () => {
            event.sender.send("siyuan-event", "blur");
        });
        if ("darwin" !== process.platform) {
            currentWindow.on("maximize", () => {
                event.sender.send("siyuan-event", "maximize");
            });
            currentWindow.on("unmaximize", () => {
                event.sender.send("siyuan-event", "unmaximize");
            });
        }
        currentWindow.on("enter-full-screen", () => {
            event.sender.send("siyuan-event", "enter-full-screen");
        });
        currentWindow.on("leave-full-screen", () => {
            event.sender.send("siyuan-event", "leave-full-screen");
        });
    });
    ipcMain.on("siyuan-focus-fix", (event) => {
        const currentWindow = getWindowByContentId(event.sender.id);
        if (currentWindow && process.platform === "win32") {
            currentWindow.blur();
            currentWindow.focus();
        }
    });
    ipcMain.on("siyuan-cmd", (event, data) => {
        let cmd = data;
        let webContentsId = event.sender.id;
        if (typeof data !== "string") {
            cmd = data.cmd;
            if (data.webContentsId) {
                webContentsId = data.webContentsId;
            }
        }
        const currentWindow = getWindowByContentId(webContentsId);
        switch (cmd) {
            case "showItemInFolder":
                shell.showItemInFolder(data.filePath);
                break;
            case "setSpellCheckerLanguages":
                BrowserWindow.getAllWindows().forEach(item => {
                    item.webContents.session.setSpellCheckerLanguages(data.languages);
                });
                break;
            case "openPath":
                shell.openPath(data.filePath);
                break;
            case "openDevTools":
                event.sender.openDevTools({mode: "bottom"});
                break;
            case "unregisterGlobalShortcut":
                if (data.accelerator) {
                    globalShortcut.unregister(hotKey2Electron(data.accelerator));
                }
                break;
            case "setTrafficLightPosition":
                if (!currentWindow || !currentWindow.setWindowButtonPosition) {
                    return;
                }
                if (new URL(currentWindow.getURL()).pathname === "/stage/build/app/window.html") {
                    data.position.y += 5 * data.zoom;
                }
                currentWindow.setWindowButtonPosition(data.position);
                break;
            case "show":
                if (!currentWindow) {
                    return;
                }
                showWindow(currentWindow);
                break;
            case "hide":
                if (!currentWindow) {
                    return;
                }
                currentWindow.hide();
                break;
            case "minimize":
                if (!currentWindow) {
                    return;
                }
                currentWindow.minimize();
                break;
            case "maximize":
                if (!currentWindow) {
                    return;
                }
                currentWindow.maximize();
                break;
            case "restore":
                if (!currentWindow) {
                    return;
                }
                if (currentWindow.isFullScreen()) {
                    currentWindow.setFullScreen(false);
                } else {
                    currentWindow.unmaximize();
                }
                break;
            case "focus":
                if (!currentWindow) {
                    return;
                }
                currentWindow.focus();
                break;
            case "setAlwaysOnTopFalse":
                if (!currentWindow) {
                    return;
                }
                currentWindow.setAlwaysOnTop(false);
                break;
            case "setAlwaysOnTopTrue":
                if (!currentWindow) {
                    return;
                }
                currentWindow.setAlwaysOnTop(true);
                break;
            case "clearCache":
                event.sender.session.clearCache();
                break;
            case "redo":
                event.sender.redo();
                break;
            case "undo":
                event.sender.undo();
                break;
            case "destroy":
                if (!currentWindow) {
                    return;
                }
                currentWindow.destroy();
                break;
            case "writeLog":
                writeLog(data.msg);
                break;
            case "closeButtonBehavior":
                if (!currentWindow) {
                    return;
                }
                if (currentWindow.isFullScreen()) {
                    currentWindow.once("leave-full-screen", () => {
                        currentWindow.hide();
                    });
                    currentWindow.setFullScreen(false);
                } else {
                    currentWindow.hide();
                }
                break;
        }
    });
    ipcMain.on("siyuan-config-tray", (event, data) => {
        workspaces.find(item => {
            if (item.browserWindow.webContents.id === event.sender.id) {
                hideWindow(item.browserWindow);
                if ("win32" === process.platform || "linux" === process.platform) {
                    resetTrayMenu(item.tray, data.languages, item.browserWindow);
                }
                return true;
            }
        });
    });
    ipcMain.on("siyuan-export-pdf", (event, data) => {
        dialog.showOpenDialog({
            title: data.title, properties: ["createDirectory", "openDirectory"],
        }).then((result) => {
            if (result.canceled) {
                event.sender.destroy();
                return;
            }
            data.filePaths = result.filePaths;
            data.webContentsId = event.sender.id;
            getWindowByContentId(data.parentWindowId).send("siyuan-export-pdf", data);
        });
    });
    ipcMain.on("siyuan-export-newwindow", (event, data) => {
        // The PDF/Word export preview window automatically adjusts according to the size of the main window https://github.com/siyuan-note/siyuan/issues/10554
        const wndBounds = getWindowByContentId(event.sender.id).getBounds();
        const wndScreen = screen.getDisplayNearestPoint({x: wndBounds.x, y: wndBounds.y});
        const printWin = new BrowserWindow({
            show: true,
            width: Math.floor(wndScreen.size.width * 0.8),
            height: Math.floor(wndScreen.size.height * 0.8),
            resizable: true,
            frame: "darwin" === process.platform,
            icon: path.join(appDir, "stage", "icon-large.png"),
            titleBarStyle: "hidden",
            webPreferences: {
                contextIsolation: false,
                nodeIntegration: true,
                webviewTag: true,
                webSecurity: false,
                autoplayPolicy: "user-gesture-required" // 桌面端禁止自动播放多媒体 https://github.com/siyuan-note/siyuan/issues/7587
            },
        });
        printWin.center();
        printWin.webContents.userAgent = "SiYuan/" + appVer + " https://b3log.org/siyuan Electron " + printWin.webContents.userAgent;
        printWin.loadURL(data);
        windowNavigate(printWin, "export");
    });
    ipcMain.on("siyuan-quit", (event, port) => {
        exitApp(port);
    });
    ipcMain.on("siyuan-show-window", (event) => {
        const mainWindow = getWindowByContentId(event.sender.id);
        if (!mainWindow) {
            return;
        }

        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.show();
    });
    ipcMain.on("siyuan-open-window", (event, data) => {
        const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
        const mainBounds = mainWindow.getBounds();
        const mainScreen = screen.getDisplayNearestPoint({x: mainBounds.x, y: mainBounds.y});
        const win = new BrowserWindow({
            show: true,
            trafficLightPosition: {x: 8, y: 13},
            width: Math.floor(data.width || mainScreen.size.width * 0.7),
            height: Math.floor(data.height || mainScreen.size.height * 0.9),
            minWidth: 493,
            minHeight: 376,
            fullscreenable: true,
            transparent: "darwin" === process.platform, // 避免缩放窗口时出现边框
            frame: "darwin" === process.platform,
            icon: path.join(appDir, "stage", "icon-large.png"),
            titleBarStyle: "hidden",
            webPreferences: {
                contextIsolation: false,
                nodeIntegration: true,
                webviewTag: true,
                webSecurity: false,
                autoplayPolicy: "user-gesture-required" // 桌面端禁止自动播放多媒体 https://github.com/siyuan-note/siyuan/issues/7587
            },
        });
        remote.enable(win.webContents);

        if (data.position) {
            win.setPosition(data.position.x, data.position.y);
        } else {
            win.center();
        }
        win.webContents.userAgent = "SiYuan/" + appVer + " https://b3log.org/siyuan Electron " + win.webContents.userAgent;
        win.webContents.session.setSpellCheckerLanguages(["en-US"]);
        win.loadURL(data.url);
        windowNavigate(win, "window");
        win.on("close", (event) => {
            if (win && !win.isDestroyed()) {
                win.webContents.send("siyuan-save-close");
            }
            event.preventDefault();
        });
        const targetScreen = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        if (mainScreen.id !== targetScreen.id) {
            win.setBounds(targetScreen.workArea);
        }
    });

    ipcMain.on("siyuan-hotkey", (event, data) => {
        if (!data.hotkeys || data.hotkeys.length === 0) {
            return;
        }
        workspaces.find(workspaceItem => {
            if (event.sender.id === workspaceItem.browserWindow.webContents.id) {
                workspaceItem.hotkeys = data.hotkeys;
                return true;
            }
        });
        data.hotkeys.forEach((item, index) => {
            const shortcut = hotKey2Electron(item);
            if (!shortcut) {
                return;
            }
            if (globalShortcut.isRegistered(shortcut)) {
                globalShortcut.unregister(shortcut);
            }
            if (index === 0) {
                globalShortcut.register(shortcut, () => {
                    let currentWorkspace;
                    const currentWebContentsId = (latestActiveWindow && !latestActiveWindow.isDestroyed()) ? latestActiveWindow.webContents.id : undefined;
                    workspaces.find(workspaceItem => {
                        if (currentWebContentsId === workspaceItem.browserWindow.webContents.id && workspaceItem.hotkeys[0] === item) {
                            currentWorkspace = workspaceItem;
                            return true;
                        }
                    });
                    if (!currentWorkspace) {
                        workspaces.find(workspaceItem => {
                            if (workspaceItem.hotkeys[0] === item && event.sender.id === workspaceItem.browserWindow.webContents.id) {
                                currentWorkspace = workspaceItem;
                                return true;
                            }
                        });
                    }
                    if (!currentWorkspace) {
                        return;
                    }
                    const mainWindow = currentWorkspace.browserWindow;
                    if (mainWindow.isMinimized()) {
                        mainWindow.restore();
                        mainWindow.show(); // 按 `Alt+M` 后隐藏窗口，再次按 `Alt+M` 显示窗口后会卡住不能编辑 https://github.com/siyuan-note/siyuan/issues/8456
                    } else {
                        if (mainWindow.isVisible()) {
                            if (!mainWindow.isFocused()) {
                                mainWindow.show();
                            } else {
                                hideWindow(mainWindow);
                            }
                        } else {
                            mainWindow.show();
                        }
                    }
                    if ("win32" === process.platform || "linux" === process.platform) {
                        resetTrayMenu(currentWorkspace.tray, data.languages, mainWindow);
                    }
                });
            } else {
                globalShortcut.register(shortcut, () => {
                    BrowserWindow.getAllWindows().forEach(itemB => {
                        itemB.webContents.send("siyuan-hotkey", {
                            hotkey: item
                        });
                    });
                });
            }
        });
    });
    ipcMain.on("siyuan-send-windows", (event, data) => {
        BrowserWindow.getAllWindows().forEach(item => {
            item.webContents.send("siyuan-send-windows", data);
        });
    });
    ipcMain.on("siyuan-auto-launch", (event, data) => {
        app.setLoginItemSettings({
            openAtLogin: data.openAtLogin,
            args: data.openAsHidden ? ["--openAsHidden"] : ""
        });
    });


    // 初始化主窗口（不再启动内核）
    initMainWindow();

    // 电源相关事件必须放在 whenReady 里面，否则会导致 Linux 端无法正常启动 Trace/breakpoint trap (core dumped) https://github.com/siyuan-note/siyuan/issues/9347
    powerMonitor.on("suspend", () => {
        writeLog("system suspend");
    });
    powerMonitor.on("resume", async () => {
        // 桌面端系统休眠唤醒后判断网络连通性后再执行数据同步 https://github.com/siyuan-note/siyuan/issues/6687
        writeLog("system resume");

        const isOnline = async () => {
            return net.isOnline();
        };
        let online = false;
        for (let i = 0; i < 7; i++) {
            if (await isOnline()) {
                online = true;
                break;
            }

            writeLog("network is offline");
            await sleep(1000);
        }

        if (!online) {
            writeLog("network is offline, do not sync after system resume");
            return;
        }

        workspaces.forEach(item => {
            const currentURL = new URL(item.browserWindow.getURL());
            const server = getServer(currentURL.port);
            writeLog("sync after system resume [" + server + "/api/sync/performSync" + "]");
            net.fetch(server + "/api/sync/performSync", {method: "POST"});
        });
    });
    powerMonitor.on("shutdown", () => {
        writeLog("system shutdown");
        workspaces.forEach(item => {
            const currentURL = new URL(item.browserWindow.getURL());
            net.fetch(getServer(currentURL.port) + "/api/system/exit", {method: "POST"});
        });
    });
    powerMonitor.on("lock-screen", () => {
        writeLog("system lock-screen");
        BrowserWindow.getAllWindows().forEach(item => {
            item.webContents.send("siyuan-send-windows", {cmd: "lockscreenByMode"});
        });
    });
});

// 处理多实例
app.on('second-instance', (event, commandLine, workingDirectory) => {
    // 当运行第二个实例时,聚焦到主窗口
    const mainWindow = workspaces[0]?.browserWindow;
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

// 关闭所有窗口时退出应用
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});