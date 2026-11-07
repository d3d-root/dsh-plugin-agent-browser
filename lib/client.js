window.__ModuleLoader__.load({
	id: "dsh-plugin-agent-browser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");

		//#region lib/client/index.js
		/**
		 * Панель встроенного браузера «Браузер агента».
		 *
		 * Внутри — настоящий Chromium (<webview>), а не картинка-трансляция:
		 * прокрутка, ввод и клики работают напрямую, без задержек.
		 *
		 * Браузер принадлежит чату (сессии). Это главное отличие от «одного
		 * общего браузера»: у каждого чата своя вкладка, свой Chromium и свой
		 * профиль (cookie, логины). Два агента в разных чатах работают
		 * одновременно и не видят браузеры друг друга.
		 *
		 * Связь с серверной половиной — через мост (`/dsh-agent-browser`):
		 *   страница  → сторож: ловит «открой/покажи/закрой вкладку в сессии X»;
		 *   панель    → получает команды браузера своей сессии и отвечает.
		 *
		 * DSH разрешает <webview> только при наличии «аренды» (lease). Аренду
		 * выдаёт публичный мост window.dshDesktop.browser. Ключ аренды — строка
		 * workspace: один и тот же ключ даёт общий профиль, разные ключи —
		 * изолированные. По умолчанию ключ включает id сессии.
		 */

		var TAB_ID = "dsh-plugin-agent-browser";
		var TAB_KIND = "agent-browser";
		/** Настройки, которые хост передал в index.html. */
		var BOOT = (typeof window !== "undefined" && window.__DSH_AGENT_BROWSER__) || {};
		var PROTOCOL = Number(BOOT.version) || 2;
		/** Базовый адрес моста: путь на встроенном сервере или полный URL. */
		var BRIDGE = (function () {
			var base = typeof BOOT.base === "string" && BOOT.base ? BOOT.base : "/dsh-agent-browser";
			if (/^https?:\/\//i.test(base)) return base;
			var origin = typeof location !== "undefined" && location.origin ? location.origin : "http://127.0.0.1";
			return origin.replace(/\/$/, "") + base;
		})();
		var TOKEN = typeof BOOT.token === "string" ? BOOT.token : "";
		// Обязательны только слоты и правая панель: без них плагину некуда
		// рисоваться. Остальные сервисы читаем через ctx.get(), чтобы плагин
		// грузился и в профилях, где их нет.
		var inject = ["slots", "sidebarRightTabs", "sidebarRight"];

		/**
		 * Забрать у моста токен, если его не оказалось в index.html.
		 *
		 * Хост вставляет настройки в index.html, но страница может быть отдана
		 * раньше, чем плагин успел зарегистрировать вставку (например, сразу
		 * после запуска приложения). Тогда `window.__DSH_AGENT_BROWSER__` пуст,
		 * и без токена любой запрос получает 403. Здесь клиент сам спрашивает
		 * токен по тому же origin — ответ читает только страница DSH.
		 * @returns true, если токен есть и мост доступен.
		 */
		var bootstrapPromise = null;
		function ensureBootstrap() {
			if (TOKEN) return Promise.resolve(true);
			if (bootstrapPromise) return bootstrapPromise;
			bootstrapPromise = fetch(BRIDGE + "/bootstrap", { cache: "no-store" })
				.then(function (response) {
					if (!response.ok) return false;
					return response.json().then(function (data) {
						if (!data || typeof data.token !== "string" || !data.token) return false;
						TOKEN = data.token;
						if (typeof data.version === "number") PROTOCOL = data.version;
						return true;
					});
				})
				.catch(function () {
					return false;
				})
				.then(function (ok) {
					if (!ok) bootstrapPromise = null;
					return ok;
				});
			return bootstrapPromise;
		}

		/**
		 * Состояние связи с мостом, видимое пользователю.
		 *
		 * Плагин состоит из двух половин: серверной (в процессе DSH) и этой,
		 * клиентской. Если серверная не загрузилась или окно открыто со старой
		 * сборкой, панель молча не работает — поэтому состояние выносится
		 * баннером в угол окна с кнопкой перезагрузки.
		 */
		var link = {
			status: "unknown", // unknown | ok | down
			reason: "",
			listeners: [],
			set: function (status, reason) {
				if (link.status === status && link.reason === (reason || "")) return;
				link.status = status;
				link.reason = reason || "";
				for (var i = 0; i < link.listeners.length; i++) link.listeners[i]();
			},
			use: function () {
				var pair = React.useState(0);
				var bump = pair[1];
				React.useEffect(function () {
					var listener = function () {
						bump(function (n) {
							return n + 1;
						});
					};
					link.listeners.push(listener);
					return function () {
						var at = link.listeners.indexOf(listener);
						if (at >= 0) link.listeners.splice(at, 1);
					};
				}, []);
				return { status: link.status, reason: link.reason };
			},
		};

		/**
		 * Баннер «плагин работает не полностью» с кнопкой перезагрузки.
		 *
		 * Появляется только при проблеме: когда всё в порядке, его нет вовсе.
		 * Это единственный способ сообщить пользователю о рассинхроне половин
		 * плагина — сам он об этом иначе не догадается.
		 */
		function AgentBrowserNotice() {
			var state = link.use();
			if (state.status !== "down") return null;
			return React.createElement(
				"div",
				{
					style: {
						position: "fixed",
						right: 16,
						bottom: 16,
						zIndex: 2147483000,
						maxWidth: 360,
						display: "flex",
						gap: 10,
						alignItems: "flex-start",
						padding: "12px 14px",
						borderRadius: 10,
						background: "#1b1f27",
						border: "1px solid #3a4150",
						boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
						color: "#c9d1e0",
						fontSize: 12.5,
						lineHeight: 1.5,
					},
				},
				React.createElement(
					"div",
					{ style: { flex: 1, minWidth: 0 } },
					React.createElement("div", { style: { fontWeight: 600, marginBottom: 2 } }, "Браузер агента"),
					React.createElement("div", { style: { color: "#8b93a1" } }, state.reason || "Плагин загружен не полностью.")
				),
				React.createElement(
					"button",
					{
						onClick: function () {
							try {
								location.reload();
							} catch (e) {
								/* перезагрузка недоступна */
							}
						},
						style: {
							flex: "none",
							cursor: "pointer",
							border: "1px solid #3a4150",
							borderRadius: 6,
							background: "#232833",
							color: "#c9d1e0",
							fontSize: 12,
							padding: "5px 10px",
						},
					},
					"Перезагрузить"
				)
			);
		}

		/** Заголовки запросов к мосту. */
		function headers() {
			var value = { "content-type": "application/json" };
			if (TOKEN) value["x-agent-browser-token"] = TOKEN;
			return value;
		}

		/** GET к мосту. */
		function apiGet(path) {
			return fetch(BRIDGE + path, { cache: "no-store", headers: headers() }).then(function (r) {
				return r.json();
			});
		}

		/** POST к мосту. */
		function apiPost(path, body) {
			return fetch(BRIDGE + path, {
				method: "POST",
				headers: headers(),
				body: JSON.stringify(body || {}),
			}).then(function (r) {
				return r.json();
			});
		}

		/** Диагностика: в консоль и в журнал серверной половины. */
		function report(level, message) {
			try {
				console.log("[agent-browser] " + message);
				apiPost("/log", { level: level, message: String(message).slice(0, 400) }).catch(function () {});
			} catch (e) {
				/* мост недоступен */
			}
		}

		/**
		 * Живые заголовки вкладок.
		 *
		 * Заголовок вкладки захватывается при открытии и не обновляется, поэтому
		 * текущее имя страницы панель кладёт сюда, а компонент заголовка читает
		 * и перерисовывается. Ключ — id вкладки.
		 */
		var tabTitles = { map: {}, listeners: {} };

		function setTabTitle(tabId, title) {
			if (!tabId || !title) return;
			if (tabTitles.map[tabId] === title) return;
			tabTitles.map[tabId] = title;
			var list = tabTitles.listeners[tabId];
			if (list) for (var i = 0; i < list.length; i++) list[i](title);
		}

		function useTabTitle(tabId) {
			var pair = React.useState(tabTitles.map[tabId] || "");
			var title = pair[0];
			var setTitle = pair[1];
			React.useEffect(
				function () {
					if (!tabId) return;
					var list = tabTitles.listeners[tabId] || (tabTitles.listeners[tabId] = []);
					list.push(setTitle);
					setTitle(tabTitles.map[tabId] || "");
					return function () {
						var at = list.indexOf(setTitle);
						if (at >= 0) list.splice(at, 1);
					};
				},
				[tabId]
			);
			return title;
		}

		/** Заголовок вкладки: короткое имя страницы. */
		function AgentBrowserTitle(props) {
			var info = props && typeof props.useTabInfo === "function" ? props.useTabInfo() : undefined;
			var tab = info && info.tab;
			var live = useTabTitle(tab && tab.id);
			return React.createElement("span", null, live || "Браузер агента");
		}

		var BTN = {
			background: "transparent",
			border: 0,
			color: "#8b93a1",
			cursor: "pointer",
			padding: "4px 7px",
			borderRadius: 4,
			fontSize: 13,
			lineHeight: 1,
			flex: "none",
		};

		/** Кнопка панели: подсвечивается на наведении. */
		function ToolButton(props) {
			var hoverPair = React.useState(false);
			var hover = hoverPair[0];
			var setHover = hoverPair[1];
			return React.createElement(
				"button",
				{
					title: props.title,
					onClick: props.onClick,
					onMouseEnter: function () {
						setHover(true);
					},
					onMouseLeave: function () {
						setHover(false);
					},
					style: Object.assign({}, BTN, hover ? { background: "#23272f", color: "#c9d1e0" } : null),
				},
				props.children
			);
		}

		/**
		 * Минимальная правка отпечатка гостя.
		 *
		 * В окне Electron у <webview> внешние размеры окна равны нулю — по этому
		 * признаку простые антибот-проверки отличают встроенный браузер от
		 * обычного. Правим только заведомо нулевые значения, чтобы не ломать
		 * сайты, которые опираются на реальные размеры.
		 */
		var STEALTH_JS =
			"(function(){try{var w=window;" +
			"if(w.outerWidth===0){Object.defineProperty(w,'outerWidth',{get:function(){return w.innerWidth},configurable:true});}" +
			"if(w.outerHeight===0){Object.defineProperty(w,'outerHeight',{get:function(){return w.innerHeight},configurable:true});}" +
			"}catch(e){}return 'ok'})()";

		/** Помощники, которые выполняются внутри страницы. */
		var PAGE_HELPERS = [
			"(function(){",
			"if(window.__dshReady) return 'готово';",
			"window.__dshReady=true;",
			"window.__dshFind=function(needle,nth){",
			"needle=String(needle).trim().toLowerCase();",
			"var sel='a,button,[role=button],input[type=submit],[onclick],summary,label,li,h1,h2,h3,td,th,span,div,p';",
			"var all=[].slice.call(document.querySelectorAll(sel));",
			"var hits=[];",
			"for(var i=0;i<all.length;i++){",
			"var el=all[i];",
			"var raw=(el.innerText||el.value||el.getAttribute('aria-label')||el.getAttribute('placeholder')||'').trim();",
			"if(!raw) continue;",
			"if(raw.toLowerCase().indexOf(needle)<0) continue;",
			"var r=el.getBoundingClientRect();",
			"if(r.width<1||r.height<1) continue;",
			"var st=getComputedStyle(el);",
			"if(st.visibility==='hidden'||st.display==='none'||Number(st.opacity)===0) continue;",
			"if(r.bottom<0||r.top>innerHeight) continue;",
			"hits.push({el:el,raw:raw,area:r.width*r.height});",
			"}",
			// Приоритет: настоящие ссылки и кнопки важнее простого текста,
			// иначе клик попадает в подпись внутри абзаца и ничего не делает.
			"var rank=function(h){",
			"var t=h.el.tagName;",
			"if(t==='A'||t==='BUTTON') return 0;",
			"if(h.el.closest('a,button,[role=button]')) return 1;",
			"if(t==='INPUT'||t==='SUMMARY'||t==='LABEL') return 2;",
			"return 3;",
			"};",
			"hits.sort(function(a,b){var d=rank(a)-rank(b);return d!==0?d:a.area-b.area;});",
			"var hit=hits[nth||0];",
			"if(!hit) return {found:false,total:hits.length};",
			"hit.el.scrollIntoView({block:'center',inline:'center'});",
			"return {found:true,total:hits.length,label:hit.raw.slice(0,80),el:hit.el};",
			"};",
			"window.__dshClick=function(el){",
			// Если попали в текст внутри ссылки — кликаем саму ссылку,
			// иначе переход не произойдёт.
			"var link=el.closest&&el.closest('a[href],button,[role=button]');",
			"if(link) el=link;",
			"var r=el.getBoundingClientRect();",
			"var o={bubbles:true,cancelable:true,view:window,clientX:r.x+r.width/2,clientY:r.y+r.height/2};",
			"['pointerdown','mousedown','pointerup','mouseup'].forEach(function(t){",
			"try{el.dispatchEvent(new PointerEvent(t,o));}catch(e){el.dispatchEvent(new MouseEvent(t,o));}",
			"});",
			"el.click();",
			"return {x:Math.round(o.clientX),y:Math.round(o.clientY)};",
			"};",
			"window.__dshSetValue=function(el,value){",
			"var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;",
			"var d=Object.getOwnPropertyDescriptor(proto,'value');",
			"if(d&&d.set) d.set.call(el,value); else el.value=value;",
			"el.dispatchEvent(new Event('input',{bubbles:true}));",
			"el.dispatchEvent(new Event('change',{bubbles:true}));",
			"return el.value;",
			"};",
			"return 'готово';",
			"})()",
		].join("");

		/** Пауза. */
		function sleep(ms) {
			return new Promise(function (resolve) {
				setTimeout(resolve, ms);
			});
		}

		/** Дождаться условия (с таймаутом). */
		async function waitFor(check, timeoutMs) {
			var deadline = Date.now() + (timeoutMs || 3000);
			while (Date.now() < deadline) {
				if (check()) return true;
				await sleep(60);
			}
			return false;
		}

		/** Сессия, в чьей панели смонтирован этот узел. */
		function sessionFromDom(element) {
			try {
				var node = element && element.closest ? element.closest("[data-sidebar-right-session]") : null;
				return node ? String(node.getAttribute("data-sidebar-right-session") || "") : "";
			} catch (e) {
				return "";
			}
		}

		/** Короткое имя сессии для подписи. */
		function shortSession(sessionId) {
			var value = String(sessionId || "");
			return value.length > 10 ? value.slice(0, 6) + "…" : value;
		}

		/**
		 * Тело вкладки: адресная строка, кнопки и сам браузер.
		 * @param props - содержит framework-хук useTabInfo (передаётся слотом).
		 */
		function AgentBrowserPanel(props) {
			var info = props && typeof props.useTabInfo === "function" ? props.useTabInfo() : undefined;
			var tab = info && info.tab;
			var tabId = (tab && tab.id) || "";
			var visible = tab ? tab.visible !== false : true;

			var hostRef = React.useRef(null);
			var viewRef = React.useRef(null);
			var leaseRef = React.useRef("");
			var sessionRef = React.useRef("");
			// Видимость меняется без пересоздания webview, а heartbeat её
			// пересказывает мосту: по ней выбирается панель, когда браузеров
			// в чате несколько.
			var visibleRef = React.useRef(visible);
			visibleRef.current = visible;
			var statusPair = React.useState("Запуск браузера…");
			var status = statusPair[0];
			var setStatus = statusPair[1];
			var addrPair = React.useState("");
			var addr = addrPair[0];
			var setAddr = addrPair[1];
			var failedPair = React.useState(false);
			var failed = failedPair[0];
			var setFailed = failedPair[1];
			var sessionPair = React.useState("");
			var sessionId = sessionPair[0];
			var setSessionId = sessionPair[1];

			React.useEffect(
				function () {
					var host = hostRef.current;
					if (!host) return;
					var disposed = false;
					var stopped = false;
					var timers = [];
					var pollTimer = null;
					/** Сессия этого браузера: панель всегда живёт в панели чата. */
					var owner = sessionFromDom(host) || (tab && tab.sessionId) || "";

					var cleanup = function () {
						disposed = true;
						stopped = true;
						for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
						if (pollTimer) clearTimeout(pollTimer);
						try {
							if (viewRef.current && viewRef.current.remove) viewRef.current.remove();
						} catch (e) {
							/* уже удалён */
						}
						viewRef.current = null;
						var lease = leaseRef.current;
						leaseRef.current = "";
						if (lease) {
							try {
								window.dshDesktop.browser.release(lease);
							} catch (e) {
								/* мост недоступен */
							}
						}
						if (tabId) {
							apiPost("/panel/bye", { panelId: tabId }).catch(function () {});
						}
					};

					var api = window.dshDesktop && window.dshDesktop.browser;
					if (!api || typeof api.acquire !== "function") {
						setFailed(true);
						setStatus("Браузер доступен только в приложении DSH: это окно открыто как обычная веб-страница.");
						return cleanup;
					}
					if (!owner) {
						setFailed(true);
						setStatus("Не удалось определить чат этой панели. Закройте вкладку и откройте её из чата ещё раз.");
						return cleanup;
					}
					sessionRef.current = owner;
					setSessionId(owner);

					var start = async function () {
						// Ключ аренды = профиль браузера. Разные чаты получают разные
						// профили: свои cookie и логины, никакого пересечения.
						var workspace = "dsh-agent-browser:" + owner;
						// Панель тоже должна уметь разговаривать с мостом: токен
						// мог не попасть в index.html при первом запуске.
						await ensureBootstrap();
						var lease;
						try {
							lease = await api.acquire(workspace);
						} catch (e) {
							setFailed(true);
							setStatus("Не удалось получить доступ к браузеру: " + String(e && e.message ? e.message : e));
							report("warn", "acquire: " + String(e && e.message ? e.message : e));
							return;
						}
						if (disposed) {
							try {
								api.release(lease.lease);
							} catch (e) {
								/* ignore */
							}
							return;
						}
						leaseRef.current = lease.lease;

						var wv = document.createElement("webview");
						wv.setAttribute("name", lease.lease);
						wv.setAttribute("partition", lease.partition);
						wv.setAttribute("allowpopups", "");
						wv.setAttribute("src", "about:blank#" + lease.lease);
						wv.style.position = "absolute";
						wv.style.left = "0";
						wv.style.top = "0";
						wv.style.width = "100%";
						wv.style.height = "100%";
						wv.style.border = "0";
						wv.style.background = "#ffffff";
						host.appendChild(wv);
						viewRef.current = wv;

						var syncUrl = function () {
							if (disposed) return;
							try {
								var url = wv.getURL ? wv.getURL() : "";
								if (url && url !== "about:blank") setAddr(url);
								var title = wv.getTitle ? wv.getTitle() : "";
								if (title) setTabTitle(tabId, title.length > 40 ? title.slice(0, 40) + "…" : title);
							} catch (e) {
								/* webview ещё не готов */
							}
						};

						var ready = new Promise(function (resolve, reject) {
							wv.addEventListener("dom-ready", function () {
								resolve();
							}, { once: true });
							wv.addEventListener(
								"did-fail-load",
								function (event) {
									// -3 = ERR_ABORTED: обычный побочный эффект перехода, не ошибка.
									if (event && event.errorCode === -3) return;
									reject(new Error(event && event.errorDescription ? event.errorDescription : "ошибка загрузки"));
								},
								{ once: true }
							);
							timers.push(
								setTimeout(function () {
									reject(new Error("браузер не ответил за 10 секунд"));
								}, 10000)
							);
						});

						try {
							await ready;
						} catch (e) {
							if (disposed) return;
							setFailed(true);
							setStatus("Браузер не запустился: " + String(e && e.message ? e.message : e));
							report("warn", "webview: " + String(e && e.message ? e.message : e));
							return;
						}
						if (disposed) return;

						wv.addEventListener("did-navigate", syncUrl);
						wv.addEventListener("did-navigate-in-page", syncUrl);
						wv.addEventListener("page-title-updated", syncUrl);
						// Каждая новая страница получает правку отпечатка заново.
						wv.addEventListener("dom-ready", function () {
							wv.executeJavaScript(STEALTH_JS, true).catch(function () {});
							syncUrl();
						});
						setStatus("");
						report("info", "webview готов: " + tabId + " (чат " + owner + ")");

						// Стартовая страница приходит с сервера: у каждого профиля она своя.
						try {
							var startInfo = await apiGet("/start");
							var startUrl = startInfo && typeof startInfo.url === "string" ? startInfo.url : "";
							if (startUrl) await wv.loadURL(startUrl);
						} catch (e) {
							report("warn", "стартовая страница: " + String(e && e.message ? e.message : e));
						}

						// Регистрируемся на мосте: теперь команды этого чата идут сюда.
						var hello = function () {
							return apiPost("/panel/hello", {
								panelId: tabId,
								sessionId: owner,
								tabId: tabId,
								visible: visibleRef.current,
							}).catch(function () {});
						};
						await hello();

						var evalJs = function (code) {
							return wv.executeJavaScript(code, true);
						};

						/** Пауза внутри последовательности событий мыши. */
						var pause = function (ms) {
							return new Promise(function (resolve) {
								setTimeout(resolve, ms);
							});
						};

						/**
						 * Перейти по адресу и дождаться, пока страница устоится.
						 *
						 * `loadURL` отвергает промис с ERR_ABORTED (-3), когда сервер
						 * отвечает редиректом: сама навигация при этом удалась, и
						 * сообщать об ошибке было бы враньём (Авито редиректит с
						 * /avtomobili на канонический адрес с фильтрами). Поэтому
						 * судьбу перехода решают события webview, а отказ промиса
						 * игнорируется.
						 *
						 * Ждём `did-stop-loading` — это конец загрузки, когда заголовок
						 * уже актуальный. `did-navigate` страхует случай, когда
						 * загрузка «зависла» на сторонних ресурсах.
						 * @param url - адрес.
						 * @returns `{ url, title }` либо `{ error }` при настоящем сбое.
						 */
						var navigateTo = function (url) {
							return new Promise(function (resolve) {
								var settled = false;
								var timer = null;
								var settleTimer = null;

								var cleanup = function () {
									if (timer) clearTimeout(timer);
									if (settleTimer) clearTimeout(settleTimer);
									try {
										wv.removeEventListener("did-navigate", onNavigate);
										wv.removeEventListener("did-navigate-in-page", onNavigate);
										wv.removeEventListener("did-stop-loading", onStop);
										wv.removeEventListener("did-fail-load", onFail);
									} catch (e) {
										/* webview уже удалён */
									}
								};

								var finish = function (extra) {
									if (settled) return;
									settled = true;
									cleanup();
									resolve(
										extra || {
											url: wv.getURL(),
											title: wv.getTitle(),
										}
									);
								};

								/** Загрузка закончилась: отдать текущий адрес и заголовок. */
								function onStop(event) {
									if (event && event.isMainFrame === false) return;
									finish();
								}

								/** Навигация началась: если загрузка не завершится, выйдем по таймеру. */
								function onNavigate(event) {
									if (event && event.isMainFrame === false) return;
									if (settleTimer) clearTimeout(settleTimer);
									settleTimer = setTimeout(finish, 1500);
								}

								/** Настоящий сбой загрузки (не отмена). */
								function onFail(event) {
									// -3 = ERR_ABORTED: редирект или отмена загрузки.
									if (event && event.errorCode === -3) return;
									finish({
										url: wv.getURL(),
										title: wv.getTitle(),
										error: (event && event.errorDescription) || "ошибка загрузки",
									});
								}

								wv.addEventListener("did-navigate", onNavigate);
								wv.addEventListener("did-navigate-in-page", onNavigate);
								wv.addEventListener("did-stop-loading", onStop);
								wv.addEventListener("did-fail-load", onFail);
								timer = setTimeout(finish, 25000);

								try {
									var loading = wv.loadURL(url);
									if (loading && typeof loading.catch === "function") {
										// Отказ самого loadURL не фатален: судьбу решают события.
										loading.catch(function () {});
									}
								} catch (e) {
									onFail({ errorCode: 0, errorDescription: String(e && e.message ? e.message : e) });
								}
							});
						};

						/**
						 * Двоичные данные в base64 без зависимости от Buffer.
						 *
						 * В renderer-процессе Node может быть недоступен, поэтому
						 * используем только браузерные средства: btoa и типизированные
						 * массивы.
						 * @param data - Uint8Array, ArrayBuffer или Buffer.
						 * @returns строка base64.
						 */
						var toBase64 = function (data) {
							var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
							var s = "";
							var chunk = 0x8000;
							for (var i = 0; i < bytes.length; i += chunk) {
								s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
							}
							return btoa(s);
						};

						/**
						 * Скриншот всей страницы, а не только видимой области.
						 *
						 * Electron снимает ровно видимую часть webview, поэтому на время
						 * съёмки элемент растягивается на высоту документа, а затем
						 * возвращается к прежнему размеру. Высота ограничена: страница в
						 * сотни тысяч пикселей съела бы память и время.
						 * @returns dataUrl и фактические размеры.
						 */
						var captureFullPage = async function () {
							var dims = { h: 0, w: 0 };
							try {
								dims = JSON.parse(
									await evalJs(
										"JSON.stringify({h:document.documentElement.scrollHeight,w:document.documentElement.scrollWidth})",
									),
								);
							} catch (e) {
								/* страница могла не успеть */
							}
							var full = Math.max(1, Math.round(Number(dims.h) || 0));
							var capped = Math.min(full, 12000);
							var saved = wv.style.cssText;
							try {
								wv.style.height = capped + "px";
								// Дать гостю пересчитать viewport под новый размер.
								await pause(450);
								var img = await wv.capturePage();
								return {
									dataUrl: img.toDataURL(),
									fullPage: true,
									width: Math.round(Number(dims.w) || 0),
									height: capped,
									truncated: full > capped,
								};
							} finally {
								wv.style.cssText = saved;
							}
						};

						var runCmd = async function (cmd) {
							try {
								if (cmd.type === "navigate") {
									var went = await navigateTo(cmd.url);
									if (went.error) return { error: went.error };
									try {
										await evalJs(STEALTH_JS);
									} catch (e) {
										/* страница могла не успеть */
									}
									return { url: went.url, title: went.title };
								}
								if (cmd.type === "back") {
									if (wv.canGoBack && wv.canGoBack()) {
										wv.goBack();
										await pause(120);
									}
									return { url: wv.getURL() };
								}
								if (cmd.type === "forward") {
									if (wv.canGoForward && wv.canGoForward()) {
										wv.goForward();
										await pause(120);
									}
									return { url: wv.getURL() };
								}
								if (cmd.type === "reload") {
									wv.reload();
									await pause(150);
									return { url: wv.getURL() };
								}
								if (cmd.type === "url") {
									return { url: wv.getURL(), title: wv.getTitle(), panel: tabId, sessionId: owner };
								}
								if (cmd.type === "text") {
									return { text: await evalJs("document.body ? document.body.innerText : ''") };
								}
								if (cmd.type === "html") {
									return { html: await evalJs("document.documentElement.outerHTML") };
								}
								if (cmd.type === "eval") {
									return { value: await evalJs(cmd.code) };
								}
								if (cmd.type === "wait") {
									// Ожидание живёт внутри страницы: так оно видит и мутации,
									// и переходы, не гоняя запросы по кругу.
									var waitCode =
										"(function(){return new Promise(function(resolve){" +
										"var started=Date.now();" +
										"var selector=" + JSON.stringify(String(cmd.selector || "")) + ";" +
										"var needle=" + JSON.stringify(String(cmd.text || "")) + ";" +
										"var deadline=started+" + Number(cmd.timeoutMs || 8000) + ";" +
										"var check=function(){" +
										"try{" +
										"if(selector){if(document.querySelector(selector)) return true;}" +
										"else if(needle){if(document.body && document.body.innerText.indexOf(needle)>=0) return true;}" +
										"}catch(e){}" +
										"return false;" +
										"};" +
										"var tick=function(){" +
										"if(check()) return resolve({found:true,waitedMs:Date.now()-started});" +
										"if(Date.now()>=deadline) return resolve({found:false,waitedMs:Date.now()-started});" +
										"setTimeout(tick,120);" +
										"};" +
										"tick();" +
										"})})()";
									return { value: await evalJs(waitCode) };
								}
								if (cmd.type === "find") {
									await evalJs(PAGE_HELPERS);
									var findCode =
										"(function(){var h=window.__dshFind(" +
										JSON.stringify(cmd.text) +
										"," +
										Number(cmd.nth || 0) +
										");if(!h.found) return JSON.stringify({found:false,total:h.total});var p=window.__dshClick(h.el);return JSON.stringify({found:true,total:h.total,label:h.label,x:p.x,y:p.y});})()";
									return { value: await evalJs(findCode) };
								}
								if (cmd.type === "clickAt") {
									await evalJs(PAGE_HELPERS);
									var atCode =
										"(function(){var el=document.elementFromPoint(" +
										Number(cmd.x) +
										"," +
										Number(cmd.y) +
										");if(!el) return 'в этой точке нет элемента';var p=window.__dshClick(el);return 'клик по <'+el.tagName.toLowerCase()+'> в '+p.x+', '+p.y;})()";
									return { value: await evalJs(atCode) };
								}
								if (cmd.type === "type") {
									await evalJs(PAGE_HELPERS);
									// Селектор — это CSS-строка, а не сам элемент:
									// раньше здесь в переменную попадала строка, и ввод падал.
									var typeCode =
										"(function(){" +
										"var selector=" + JSON.stringify(String(cmd.selector || "")) + ";" +
										"var el=null;" +
										"if(selector){try{el=document.querySelector(selector);}catch(e){return JSON.stringify({ok:false,reason:'плохой селектор: '+selector});}}" +
										"if(!el){var a=document.activeElement;if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.isContentEditable)) el=a;}" +
										"if(!el) el=document.querySelector('textarea[name=q],input[name=q],input[type=search],input[type=text],textarea');" +
										"if(!el) return JSON.stringify({ok:false,reason:'поле не найдено'});" +
										"el.focus();" +
										"var value=window.__dshSetValue(el," + JSON.stringify(String(cmd.text || "")) + ");" +
										"return JSON.stringify({ok:true,value:value,tag:el.tagName.toLowerCase(),name:el.name||''});" +
										"})()";
									return { value: await evalJs(typeCode) };
								}
								if (cmd.type === "submit") {
									await evalJs(PAGE_HELPERS);
									var submitCode =
										"(function(){var el=document.activeElement;if(!el) return 'нет активного элемента';" +
										"var o={bubbles:true,cancelable:true,key:'Enter',code:'Enter',keyCode:13,which:13};" +
										"el.dispatchEvent(new KeyboardEvent('keydown',o));el.dispatchEvent(new KeyboardEvent('keypress',o));el.dispatchEvent(new KeyboardEvent('keyup',o));" +
										"var f=el.form||el.closest('form');if(f){if(f.requestSubmit) f.requestSubmit();else f.submit();return 'форма отправлена';}return 'Enter отправлен';})()";
									return { value: await evalJs(submitCode) };
								}
								if (cmd.type === "key") {
									await evalJs(PAGE_HELPERS);
									var keyCode =
										"(function(){var el=document.activeElement||document.body;var o={bubbles:true,cancelable:true,key:" +
										JSON.stringify(String(cmd.key || "")) +
										",keyCode:" +
										Number(cmd.code || 0) +
										",which:" +
										Number(cmd.code || 0) +
										"};el.dispatchEvent(new KeyboardEvent('keydown',o));el.dispatchEvent(new KeyboardEvent('keypress',o));el.dispatchEvent(new KeyboardEvent('keyup',o));return 'нажато '+" +
										JSON.stringify(String(cmd.key || "")) +
										";})()";
									return { value: await evalJs(keyCode) };
								}
								if (cmd.type === "scroll") {
									var scrollCode =
										"(function(){window.scrollBy(0," +
										Math.round(Number(cmd.deltaY || 0)) +
										");return JSON.stringify({y:Math.round(window.scrollY),h:document.body.scrollHeight,vh:innerHeight});})()";
									return { value: await evalJs(scrollCode) };
								}
								if (cmd.type === "screenshot") {
									var rect =
										cmd.rect && Number(cmd.rect.width) > 0 && Number(cmd.rect.height) > 0
											? {
													x: Math.max(0, Math.round(Number(cmd.rect.x) || 0)),
													y: Math.max(0, Math.round(Number(cmd.rect.y) || 0)),
													width: Math.round(Number(cmd.rect.width)),
													height: Math.round(Number(cmd.rect.height)),
												}
											: undefined;
									if (cmd.fullPage) return await captureFullPage();
									var img = await wv.capturePage(rect);
									return { dataUrl: img.toDataURL() };
								}
								// Загрузка файлов в <input type=file>. Пути приходят с хоста:
								// в странице нет доступа к диску, поэтому содержимое
								// передаётся как base64 и собирается в объекты File.
								if (cmd.type === "upload") {
									await evalJs(PAGE_HELPERS);
									var upCode =
										"(function(){" +
										"var selector=" + JSON.stringify(String(cmd.selector || "")) + ";" +
										"var files=" + JSON.stringify(cmd.files || []) + ";" +
										"var el=selector?document.querySelector(selector):document.querySelector('input[type=file]');" +
										"if(!el) return JSON.stringify({ok:false,reason:'поле для файлов не найдено'});" +
										"if(el.tagName!=='INPUT'||el.type!=='file') return JSON.stringify({ok:false,reason:'это не input[type=file]'});" +
										"var dt=new DataTransfer();" +
										"for(var i=0;i<files.length;i++){" +
										"var f=files[i];" +
										"var bin=atob(f.base64);" +
										"var buf=new Uint8Array(bin.length);" +
										"for(var j=0;j<bin.length;j++) buf[j]=bin.charCodeAt(j);" +
										"dt.items.add(new File([buf],f.name,{type:f.mime||'application/octet-stream'}));" +
										"}" +
										"el.files=dt.files;" +
										"el.dispatchEvent(new Event('input',{bubbles:true}));" +
										"el.dispatchEvent(new Event('change',{bubbles:true}));" +
										"return JSON.stringify({ok:true,count:el.files.length,names:Array.prototype.map.call(el.files,function(x){return x.name;})});" +
										"})()";
									return { value: await evalJs(upCode) };
								}
								// Скачивание в обход блокировки DSH: содержимое забирается
								// из страницы (там нет CORS для своего origin), кодируется и
								// передаётся хосту, который пишет файл в рабочий каталог чата.
								if (cmd.type === "download") {
									var dlCode =
										"(async function(){" +
										"var url=" + JSON.stringify(String(cmd.url || "")) + ";" +
										"if(!url) return JSON.stringify({ok:false,reason:'не указан адрес'});" +
										"var r=await fetch(url,{credentials:'include'});" +
										"if(!r.ok) return JSON.stringify({ok:false,reason:'HTTP '+r.status});" +
										"var blob=await r.blob();" +
										"if(blob.size>" + Number(cmd.maxBytes || 32 * 1024 * 1024) + ") return JSON.stringify({ok:false,reason:'файл больше лимита'});" +
										"var buf=new Uint8Array(await blob.arrayBuffer());" +
										"var s='';var chunk=0x8000;" +
										"for(var i=0;i<buf.length;i+=chunk) s+=String.fromCharCode.apply(null,buf.subarray(i,i+chunk));" +
										"return JSON.stringify({ok:true,base64:btoa(s),size:blob.size,mime:blob.type||''});" +
										"})()";
									var dl = JSON.parse(await evalJs(dlCode));
									return { value: dl };
								}
								// Печать страницы в PDF: Chromium делает это сам, хост
								// сохраняет готовые байты в файл.
								if (cmd.type === "pdf") {
									if (typeof wv.printToPDF !== "function") {
										return { value: { ok: false, reason: "printToPDF недоступен" } };
									}
									var pdfBuf = await wv.printToPDF({
										printBackground: cmd.printBackground !== false,
										landscape: cmd.landscape === true,
										pageSize: cmd.pageSize || "A4",
									});
									return { pdfBase64: toBase64(pdfBuf) };
								}
								// Масштаб: мелкий сайт не влезает в узкую панель.
								if (cmd.type === "zoom") {
									if (typeof wv.setZoomFactor === "function") {
										wv.setZoomFactor(Number(cmd.factor) || 1);
									}
									return { value: { ok: true, factor: Number(cmd.factor) || 1 } };
								}
								// Поиск по тексту страницы средствами Chromium: подсвечивает
								// совпадения так же, как Ctrl+F.
								if (cmd.type === "findInPage") {
									if (typeof wv.findInPage !== "function") {
										return { value: { ok: false, reason: "findInPage недоступен" } };
									}
									var needle = String(cmd.text || "");
									if (!needle) return { value: { ok: false, reason: "пустой запрос" } };
									var res = await new Promise(function (resolve) {
										var done = false;
										var onFound = function (event) {
											if (done) return;
											done = true;
											try {
												wv.removeEventListener("found-in-page", onFound);
											} catch (e) {}
											resolve({
												matches: event.result ? event.result.matches : 0,
												active: event.result ? event.result.activeMatchOrdinal : 0,
											});
										};
										wv.addEventListener("found-in-page", onFound);
										wv.findInPage(needle, {
											forward: cmd.backward !== true,
											findNext: cmd.findNext === true,
										});
										setTimeout(function () {
											if (done) return;
											done = true;
											try {
												wv.removeEventListener("found-in-page", onFound);
											} catch (e) {}
											resolve({ matches: 0, active: 0, timeout: true });
										}, 3000);
									});
									return { value: { ok: true, text: needle, matches: res.matches, active: res.active } };
								}
								// Пронумерованный список найденных элементов: агент сначала
								// смотрит, потом кликает точный номер вместо угадывания по тексту.
								if (cmd.type === "findAll") {
									await evalJs(PAGE_HELPERS);
									var allCode =
										"(function(){" +
										"var selector=" + JSON.stringify(String(cmd.selector || "")) + ";" +
										"var needle=" + JSON.stringify(String(cmd.text || "")) + ";" +
										"var limit=" + Number(cmd.limit || 30) + ";" +
										"var nodes=[];" +
										"if(selector){try{nodes=Array.prototype.slice.call(document.querySelectorAll(selector));}catch(e){return JSON.stringify({ok:false,reason:'плохой селектор: '+selector});}}" +
										"else if(needle){" +
										"var want=needle.toLowerCase();" +
										"var all=Array.prototype.slice.call(document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick],label,summary'));" +
										"nodes=all.filter(function(el){var t=(el.innerText||el.value||el.getAttribute('aria-label')||'').toLowerCase();return t.indexOf(want)>=0;});" +
										"}" +
										"var out=[];var idx=0;" +
										"for(var i=0;i<nodes.length && out.length<limit;i++){" +
										"var el=nodes[i];var r=el.getBoundingClientRect();" +
										"var st=window.getComputedStyle(el);" +
										"if(st.display==='none'||st.visibility==='hidden'||r.width===0||r.height===0) continue;" +
										"out.push({index:idx++,tag:el.tagName.toLowerCase(),text:(el.innerText||el.value||el.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ').slice(0,80),x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),href:el.getAttribute('href')||''});" +
										"}" +
										"window.__dshFound=out;" +
										"return JSON.stringify({ok:true,total:nodes.length,shown:out.length,items:out});" +
										"})()";
									return { value: await evalJs(allCode) };
								}
								// Клик по элементу из последнего findAll — по номеру.
								if (cmd.type === "clickIndex") {
									await evalJs(PAGE_HELPERS);
									var ciCode =
										"(function(){" +
										"var list=window.__dshFound||[];" +
										"var i=" + Number(cmd.index || 0) + ";" +
										"if(!list.length) return JSON.stringify({ok:false,reason:'сначала вызовите browser_find_all'});" +
										"if(i<0||i>=list.length) return JSON.stringify({ok:false,reason:'нет элемента с номером '+i});" +
										"var it=list[i];" +
										"var el=document.elementFromPoint(it.x,it.y);" +
										"if(!el) return JSON.stringify({ok:false,reason:'элемент вне экрана'});" +
										"var p=window.__dshClick(el);" +
										"return JSON.stringify({ok:true,index:i,text:it.text,x:p.x,y:p.y});" +
										"})()";
									return { value: await evalJs(ciCode) };
								}
								// Структурированное извлечение: массив объектов по селекторам.
								// Заменяет чтение простыни текста, когда нужна таблица.
								if (cmd.type === "extract") {
									await evalJs(PAGE_HELPERS);
									var exCode =
										"(function(){" +
										"var rows=" + JSON.stringify(String(cmd.selector || "")) + ";" +
										"var fields=" + JSON.stringify(cmd.fields || {}) + ";" +
										"var limit=" + Number(cmd.limit || 50) + ";" +
										"var nodes=[];" +
										"try{nodes=Array.prototype.slice.call(document.querySelectorAll(rows));}catch(e){return JSON.stringify({ok:false,reason:'плохой селектор: '+rows});}" +
										"var out=[];" +
										"for(var i=0;i<nodes.length && out.length<limit;i++){" +
										"var n=nodes[i];var o={};" +
										"for(var key in fields){" +
										"var spec=fields[key];var val='';" +
										"if(typeof spec==='string'){" +
										"if(spec.charAt(0)==='@'){var attr=spec.slice(1);val=n.getAttribute(attr)||'';}" +
										"else{var sub=n.querySelector(spec);val=sub?(sub.innerText||sub.textContent||''):'';}" +
										"}else{val='';}" +
										"o[key]=String(val).trim().replace(/\\s+/g,' ');" +
										"}" +
										"out.push(o);" +
										"}" +
										"return JSON.stringify({ok:true,total:nodes.length,count:out.length,items:out});" +
										"})()";
									return { value: await evalJs(exCode) };
								}
								// Сохранение состояния входа: cookie и localStorage текущего
								// origin. Хост пишет это в папку плагина, а при следующем
								// открытии восстанавливает — профиль Chromium в DSH
								// непереживает перезапуск, а это состояние переживёт.
								if (cmd.type === "storageSave") {
									var ssCode =
										"(function(){" +
										"var o={origin:location.origin,cookie:document.cookie,local:{},session:{}};" +
										"try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o.local[k]=localStorage.getItem(k);}}catch(e){}" +
										"try{for(var j=0;j<sessionStorage.length;j++){var s=sessionStorage.key(j);o.session[s]=sessionStorage.getItem(s);}}catch(e){}" +
										"return JSON.stringify(o);" +
										"})()";
									return { value: JSON.parse(await evalJs(ssCode)) };
								}
								if (cmd.type === "storageRestore") {
									var srCode =
										"(function(){" +
										"var data=" + JSON.stringify(cmd.data || {}) + ";" +
										"var restored={cookie:0,local:0,session:0};" +
										"if(data.cookie){var parts=String(data.cookie).split(';');" +
										"for(var i=0;i<parts.length;i++){var p=parts[i].trim();if(!p) continue;" +
										"try{document.cookie=p+'; path=/';restored.cookie++;}catch(e){}}}" +
										"try{for(var k in (data.local||{})){localStorage.setItem(k,data.local[k]);restored.local++;}}catch(e){}" +
										"try{for(var s in (data.session||{})){sessionStorage.setItem(s,data.session[s]);restored.session++;}}catch(e){}" +
										"return JSON.stringify(restored);" +
										"})()";
									return { value: JSON.parse(await evalJs(srCode)) };
								}
								// Состояние страницы для трассировки и диагностики.
								if (cmd.type === "pageState") {
									var psCode =
										"(function(){" +
										"return JSON.stringify({" +
										"origin:location.origin,url:location.href,title:document.title," +
										"ready:document.readyState," +
										"cookies:document.cookie.length," +
										"localKeys:Object.keys(localStorage||{}).length," +
										"scrollY:Math.round(window.scrollY)," +
										"scrollHeight:document.documentElement.scrollHeight," +
										"viewport:window.innerHeight" +
										"});" +
										"})()";
									return { value: JSON.parse(await evalJs(psCode)) };
								}
								// Реальные события мыши Chromium (не DOM-синтетика): нужны
								// слайдер-пазлам, которые проверяют траекторию и доверие к событию.
								if (cmd.type === "mouseClick" || cmd.type === "drag" || cmd.type === "wheel") {
									var sendInput = function (event) {
										if (typeof wv.sendInputEvent !== "function") {
											throw new Error("sendInputEvent недоступен в этой сборке");
										}
										wv.sendInputEvent(event);
									};
									if (cmd.type === "wheel") {
										sendInput({
											type: "mouseWheel",
											x: Math.round(Number(cmd.x) || 0),
											y: Math.round(Number(cmd.y) || 0),
											deltaX: Number(cmd.deltaX) || 0,
											deltaY: Number(cmd.deltaY) || 0,
										});
										return { ok: true };
									}
									if (cmd.type === "mouseClick") {
										var cx = Math.round(Number(cmd.x) || 0);
										var cy = Math.round(Number(cmd.y) || 0);
										sendInput({ type: "mouseMove", x: cx, y: cy });
										await pause(50 + Math.random() * 70);
										sendInput({ type: "mouseDown", x: cx, y: cy, button: "left", clickCount: 1 });
										await pause(55 + Math.random() * 80);
										sendInput({ type: "mouseUp", x: cx, y: cy, button: "left", clickCount: 1 });
										return { ok: true, x: cx, y: cy };
									}
									var from = cmd.from || {};
									var to = cmd.to || {};
									var steps = Math.max(6, Math.min(90, Number(cmd.steps) || 28));
									var x0 = Math.round(Number(from.x) || 0);
									var y0 = Math.round(Number(from.y) || 0);
									var x1 = Math.round(Number(to.x) || 0);
									var y1 = Math.round(Number(to.y) || 0);
									sendInput({ type: "mouseMove", x: x0, y: y0 });
									await pause(70 + Math.random() * 70);
									sendInput({ type: "mouseDown", x: x0, y: y0, button: "left", clickCount: 1 });
									await pause(110 + Math.random() * 90);
									for (var si = 1; si <= steps; si++) {
										var f = si / steps;
										var ease = 1 - Math.pow(1 - f, 2);
										var mx = Math.round(x0 + (x1 - x0) * ease + (Math.random() - 0.5) * 1.8);
										var my = Math.round(y0 + (y1 - y0) * ease + (Math.random() - 0.5) * 1.8);
										sendInput({ type: "mouseMove", x: mx, y: my, button: "left" });
										await pause(7 + Math.random() * 15);
									}
									await pause(200 + Math.random() * 180);
									sendInput({ type: "mouseUp", x: x1, y: y1, button: "left", clickCount: 1 });
									return { ok: true, from: [x0, y0], to: [x1, y1], steps: steps };
								}
								// Подмена UA: встроенный Chromium иначе выдаёт себя строкой Electron.
								if (cmd.type === "ua") {
									if (cmd.ua && typeof wv.setUserAgent === "function") wv.setUserAgent(String(cmd.ua));
									if (cmd.reload !== false) {
										wv.reload();
										await pause(200);
									}
									return { ok: true, url: wv.getURL() };
								}
								// Мелкая правка отпечатка: у гостя в окне Electron outerWidth/Height = 0,
								// по этому признаку часть антибот-проверок сразу видит автоматизацию.
								if (cmd.type === "stealth") {
									return { value: await evalJs(STEALTH_JS) };
								}
								return { error: "неизвестная команда: " + cmd.type };
							} catch (e) {
								return { error: String(e && e.message ? e.message : e) };
							}
						};

						var poll = function () {
							if (stopped || disposed) return;
							apiGet("/panel/poll?panel=" + encodeURIComponent(tabId))
								.then(async function (cmd) {
									if (cmd && cmd.id !== undefined && cmd.type) {
										var result = await runCmd(cmd);
										await apiPost("/panel/reply", {
											id: cmd.id,
											ok: !result.error,
											result: result,
										}).catch(function () {});
										syncUrl();
									}
								})
								.catch(function () {})
								.then(function () {
									if (!stopped && !disposed) pollTimer = setTimeout(poll, 80);
								});
						};
						poll();

						// Держим на мосте признак «на экране»: по нему выбирается панель,
						// когда у чата открыто несколько браузеров.
						var heartbeat = function () {
							if (stopped || disposed) return;
							hello();
							timers.push(setTimeout(heartbeat, 15000));
						};
						timers.push(setTimeout(heartbeat, 15000));
					};

					start();
					return cleanup;
				},
				[tabId]
			);

			// Видимость вкладки меняется без пересоздания webview: сообщаем мосту,
			// чтобы он знал, какая панель сейчас на экране.
			React.useEffect(
				function () {
					if (!tabId || !sessionId) return;
					apiPost("/panel/hello", {
						panelId: tabId,
						sessionId: sessionId,
						tabId: tabId,
						visible: visible,
					}).catch(function () {});
				},
				[tabId, sessionId, visible]
			);

			/** Перейти по адресу или выполнить поиск. */
			var openUrl = function (raw) {
				var target = String(raw || "").trim();
				if (!target) return;
				var looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^about:/i.test(target);
				var hasDot = /^[^\s]+\.[^\s]{2,}/.test(target);
				if (!looksLikeUrl) {
					target =
						hasDot && !/\s/.test(target)
							? "https://" + target
							: "https://www.google.com/search?q=" + encodeURIComponent(target);
				}
				setAddr(target);
				var wv = viewRef.current;
				if (!wv) return;
				try {
					wv.loadURL(target).catch(function () {});
				} catch (e) {
					/* webview не готов */
				}
			};

			var act = function (fn) {
				return function () {
					var wv = viewRef.current;
					if (!wv) return;
					try {
						fn(wv);
					} catch (e) {
						/* ignore */
					}
				};
			};

			var bar = React.createElement(
				"div",
				{
					key: "bar",
					style: {
						display: "flex",
						alignItems: "center",
						gap: 2,
						padding: "0 6px",
						height: 34,
						flex: "none",
						background: "#15181f",
						borderBottom: "1px solid #23272f",
					},
				},
				React.createElement(
					ToolButton,
					{ key: "back", title: "Назад", onClick: act(function (wv) { if (wv.canGoBack && wv.canGoBack()) wv.goBack(); }) },
					"\u2190"
				),
				React.createElement(
					ToolButton,
					{ key: "fwd", title: "Вперёд", onClick: act(function (wv) { if (wv.canGoForward && wv.canGoForward()) wv.goForward(); }) },
					"\u2192"
				),
				React.createElement(ToolButton, { key: "reload", title: "Обновить", onClick: act(function (wv) { wv.reload(); }) }, "\u21bb"),
				React.createElement(
					ToolButton,
					{ key: "home", title: "Стартовая страница", onClick: function () { openUrl("https://www.google.com"); } },
					"\u2302"
				),
				React.createElement("input", {
					key: "addr",
					value: addr,
					spellCheck: false,
					placeholder: "Введите адрес или поисковый запрос",
					onChange: function (e) {
						setAddr(e.target.value);
					},
					onKeyDown: function (e) {
						if (e.key === "Enter" || e.keyCode === 13) {
							e.preventDefault();
							e.stopPropagation();
							openUrl(addr);
						}
					},
					style: {
						flex: 1,
						minWidth: 0,
						background: "#0e1014",
						border: "1px solid #23272f",
						borderRadius: 5,
						padding: "4px 9px",
						color: "#c9d1e0",
						fontSize: 12,
						outline: "none",
					},
				}),
				// Подпись чата: сразу видно, чей это браузер, когда открыто несколько.
				React.createElement(
					"span",
					{
						key: "owner",
						title: sessionId ? "Браузер чата " + sessionId : "",
						style: { color: "#5d6572", fontSize: 11, flex: "none", padding: "0 4px" },
					},
					sessionId ? "чат " + shortSession(sessionId) : ""
				)
			);

			var stage = [
				React.createElement("div", {
					key: "host",
					ref: hostRef,
					style: { position: "absolute", inset: 0, background: "#ffffff" },
				}),
			];

			if (status) {
				stage.push(
					React.createElement(
						"div",
						{
							key: "status",
							style: {
								position: "absolute",
								inset: 0,
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								padding: 28,
								textAlign: "center",
								lineHeight: 1.6,
								fontSize: 12.5,
								color: failed ? "#f87171" : "#8b93a1",
								background: failed ? "#12141a" : "rgba(18,20,26,0.82)",
								pointerEvents: "none",
							},
						},
						status
					)
				);
			}

			return React.createElement(
				"div",
				{
					style: {
						position: "relative",
						width: "100%",
						height: "100%",
						minHeight: 0,
						display: "flex",
						flexDirection: "column",
						background: "#0e1014",
					},
				},
				bar,
				React.createElement(
					"div",
					{ key: "stage", style: { position: "relative", flex: 1, minHeight: 0, background: "#ffffff" } },
					stage
				)
			);
		}

		/**
		 * Сторож страницы: единственная точка, через которую серверная половина
		 * просит клиент открыть, показать или закрыть вкладку в конкретном чате.
		 */
		function createController(ctx) {
			var clientId = "";
			var stopped = false;
			var pollTimer = null;
			/** Сообщали ли уже, что мост недоступен: не спамим журнал. */
			var announced = false;

			/** Сессии, известные этому окну. */
			function knownSessions() {
				try {
					var sessions = ctx.get("sessions");
					var snapshot = sessions && sessions.list && sessions.list.getSnapshot();
					return snapshot && Array.isArray(snapshot.ids) ? snapshot.ids : [];
				} catch (e) {
					return [];
				}
			}

			/** Сервис переключения чатов, если он есть в этом профиле. */
			function workspace() {
				try {
					return ctx.get("uiWorkspace");
				} catch (e) {
					return undefined;
				}
			}

			/** Чат, который сейчас на экране. */
			function onScreen() {
				try {
					return ctx.sidebarRight.mounted.getSnapshot();
				} catch (e) {
					return undefined;
				}
			}

			/** Вкладки нашего типа в сессии. */
			function ourTabs(sessionId) {
				try {
					var tabs = ctx.sidebarRight.tabsIn(sessionId) || [];
					return tabs.filter(function (tab) {
						return tab && tab.kind === TAB_KIND;
					});
				} catch (e) {
					return [];
				}
			}

			/**
			 * Выполнить действие над сессией, при необходимости переключив чат.
			 *
			 * Вкладку можно открыть только в сессии, чьё состояние панели уже
			 * создано, а создаётся оно при показе чата. Поэтому при `focus`
			 * переключаемся и остаёмся, иначе — переключаемся, делаем дело и
			 * возвращаемся назад.
			 */
			async function withSession(sessionId, focus, action) {
				var previous = onScreen();
				var switcher = workspace();
				var switched = false;
				if (previous !== sessionId) {
					if (!switcher || typeof switcher.openSession !== "function") return { code: "not-mine" };
					switcher.openSession(sessionId);
					switched = await waitFor(function () {
						return onScreen() === sessionId;
					}, 4000);
					if (!switched) return { code: "not-mine" };
				}
				try {
					return await action();
				} finally {
					if (switched && !focus && previous) {
						await sleep(180);
						try {
							switcher.openSession(previous);
						} catch (e) {
							/* чат могли закрыть, пока мы работали */
						}
					}
				}
			}

			/** Открыть вкладку браузера в чате. */
			function openTab(sessionId, focus) {
				return withSession(sessionId, focus, async function () {
					// revealIfOpened: уже открытую вкладку не дублируем, а показываем.
					ctx.sidebarRight.openTab(TAB_KIND, { revealIfOpened: true });
					// Дать React смонтировать тело и панели выйти на мост.
					await sleep(220);
					return { opened: true, sessionId: sessionId };
				});
			}

			/** Показать вкладку на экране, не меняя, кто получает команды. */
			function revealTab(sessionId) {
				return withSession(sessionId, true, async function () {
					var tabs = ourTabs(sessionId);
					if (tabs.length === 0) return { code: "not-mine" };
					try {
						ctx.sidebarRight.focus(tabs[0].id);
					} catch (e) {
						ctx.sidebarRight.openTab(TAB_KIND, { revealIfOpened: true });
					}
					await sleep(160);
					return { revealed: tabs[0].id, sessionId: sessionId };
				});
			}

			/** Закрыть вкладку браузера в чате. */
			function closeTab(sessionId) {
				return withSession(sessionId, false, async function () {
					var tabs = ourTabs(sessionId);
					if (tabs.length === 0) return { closed: 0, sessionId: sessionId };
					for (var i = 0; i < tabs.length; i++) {
						try {
							ctx.sidebarRight.close(tabs[i].id);
						} catch (e) {
							/* вкладку уже закрыли */
						}
					}
					await sleep(160);
					return { closed: tabs.length, sessionId: sessionId };
				});
			}

			/** Обработать одну команду серверной половины. */
			async function handle(command) {
				var sessionId = typeof command.sessionId === "string" ? command.sessionId : "";
				// Сессия не из этого окна — молча уступаем другому окну DSH.
				if (!sessionId || knownSessions().indexOf(sessionId) < 0) return { code: "not-mine" };
				var focus = command.focus !== false;
				if (command.type === "open") return openTab(sessionId, focus);
				if (command.type === "reveal") return revealTab(sessionId);
				if (command.type === "close") return closeTab(sessionId);
				return { code: "unknown", error: "неизвестная управляющая команда: " + command.type };
			}

			/** Зарегистрироваться и ждать команды длинным опросом. */
			async function loop() {
				if (stopped) return;
				try {
					// Токен мог не попасть в index.html (страница отдана раньше,
					// чем плагин зарегистрировал вставку). Забираем его сами.
					if (!TOKEN) {
						var ready = await ensureBootstrap();
						if (!ready) {
							link.set(
								"down",
								"Серверная половина плагина не отвечает. Перезагрузите окно; если не поможет — перезапустите DeepSeek Harness."
							);
							if (!announced) {
								announced = true;
								report("warn", "мост не отдал токен: перезапустите DeepSeek Harness");
							}
							if (!stopped) pollTimer = setTimeout(loop, 2000);
							return;
						}
					}
					if (!clientId) {
						var hello = await apiPost("/client/hello", {});
						if (hello && hello.clientId) {
							clientId = hello.clientId;
							announced = false;
							link.set("ok", "");
							report("info", "сторож открытия подключён к мосту");
						}
					}
					if (clientId) {
						var command = await apiGet("/client/poll?client=" + encodeURIComponent(clientId));
						if (command && command.id !== undefined && command.type) {
							var result;
							var ok = true;
							try {
								result = await handle(command);
								if (result && result.code === "not-mine") ok = false;
							} catch (e) {
								ok = false;
								result = { error: String(e && e.message ? e.message : e) };
							}
							await apiPost("/client/reply", { id: command.id, ok: ok, result: result }).catch(function () {});
						}
					}
				} catch (e) {
					clientId = "";
				}
				if (!stopped) pollTimer = setTimeout(loop, clientId ? 80 : 1200);
			}

			return {
				start: function () {
					setTimeout(loop, 400);
				},
				stop: function () {
					stopped = true;
					if (pollTimer) clearTimeout(pollTimer);
				},
			};
		}

		/**
		 * Обёрнуть регистрацию в эффект Cordis.
		 *
		 * Это обязательное требование для горячей перезагрузки: при выгрузке
		 * плагина эффект снимает регистрацию, иначе повторная загрузка падает на
		 * конфликте идентификаторов («already registered»), плагин остаётся
		 * недогруженным — и панель пропадает до перезагрузки окна.
		 * @param ctx - контекст клиента.
		 * @param label - имя эффекта для диагностики.
		 * @param register - функция, возвращающая disposer.
		 */
		function keep(ctx, label, register) {
			if (typeof ctx.effect !== "function") {
				register();
				return;
			}
			ctx.effect(function () {
				return register();
			}, label);
		}

		/**
		 * Регистрация типа вкладки, её тела и живого заголовка.
		 *
		 * Всё через `keep()`: без снятия регистраций горячая перезагрузка ломает
		 * клиентскую половину, и вкладка исчезает до перезагрузки окна.
		 */
		function apply(ctx) {
			report("info", "клиентский плагин загружен (протокол " + PROTOCOL + ", мост " + BRIDGE + ")");

			// Отметка для сторожа из index.html: он проверяет её через несколько
			// секунд и, если её нет, показывает баннер «перезагрузите окно».
			// Заодно снимаем баннер, если он успел появиться.
			try {
				window.__DSH_AGENT_BROWSER_CLIENT__ = true;
				var stale = document.getElementById("dsh-agent-browser-reload");
				if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
			} catch (e) {
				/* не критично */
			}

			keep(ctx, "agent-browser.tab-type", function () {
				return ctx.sidebarRightTabs.register({
					id: TAB_ID,
					kind: TAB_KIND,
					multiple: true,
					keepMounted: true,
					title: function () {
						return "Браузер агента";
					},
					guide: [
						{
							id: "agent-browser",
							order: 30,
							title: function () {
								return "Браузер агента";
							},
							description: function () {
								return "Настоящий браузер: в нём работаете и вы, и агент";
							},
						},
					],
				});
			});

			keep(ctx, "agent-browser.tab-body", function () {
				return ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, AgentBrowserPanel);
			});
			keep(ctx, "agent-browser.tab-title", function () {
				return ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, AgentBrowserTitle);
			});

			// Баннер о рассинхроне половин плагина. Сидим в общем слое окна:
			// он не привязан к сессии и виден из любого чата. Регистрируемся
			// через inject — слой объявляется другим плагином, и порядок
			// загрузки не гарантирован.
			try {
				ctx.slots.inject("shell.overlay", function () {
					return ctx.slots.register({ name: "shell.overlay", id: "agent-browser-notice" }, AgentBrowserNotice);
				});
			} catch (e) {
				// Слой может быть не объявлен в этой сборке — без него всё работает.
				report("warn", "баннер недоступен: " + String(e && e.message ? e.message : e));
			}

			var controller = createController(ctx);
			controller.start();
			keep(ctx, "agent-browser.controller", function () {
				return function () {
					controller.stop();
				};
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
