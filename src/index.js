/**
 * @author Kuitos
 * @homepage https://github.com/kuitos/
 * @since 2018-08-15 11:37
 */

import processTpl, { genLinkReplaceSymbol, genScriptReplaceSymbol } from './process-tpl';
import { defaultGetPublicPath, getGlobalProp, getInlineCode, noteGlobalProps, requestIdleCallback } from './utils';

const styleCache = {};
const scriptCache = {};
const embedHTMLCache = {};
if (!window.fetch) {
	throw new Error('[import-html-entry] Here is no "fetch" on the window env, you need to polyfill it');
}
const defaultFetch = window.fetch.bind(window);

function defaultGetTemplate(tpl) {
	return tpl;
}

/**
 * convert external css link to inline style for performance optimization，外部样式转换成内联样式
 * @param template，html 模版
 * @param styles link 样式链接
 * @param opts = { fetch }
 * @return embedHTML 处理过后的 html 模版
 */
function getEmbedHTML(template, styles, opts = {}) {
	const { fetch = defaultFetch } = opts;
	let embedHTML = template;

	return getExternalStyleSheets(styles, fetch)
		.then(styleSheets => {
			// 通过循环，将之前设置的 link 注释标签替换为 style 标签，即 <style>/* href地址 */ xx </style>
			embedHTML = styles.reduce((html, styleSrc, i) => {
				html = html.replace(genLinkReplaceSymbol(styleSrc), `<style>/* ${styleSrc} */${styleSheets[i]}</style>`);
				return html;
			}, embedHTML);
			return embedHTML;
		});
}

const isInlineCode = code => code.startsWith('<');

/**
 * 返回一段 JS 代码字符串，并设置 JS 代码的执行上下文
 * @param {*} scriptSrc JS 代码的链接
 * @param {*} scriptText JS 代码
 * @param {*} proxy JS 代码的执行上下文
 * @param {*} strictGlobal 
 */
function getExecutableScript(scriptSrc, scriptText, proxy, strictGlobal) {
	const sourceUrl = isInlineCode(scriptSrc) ? '' : `//# sourceURL=${scriptSrc}\n`;

	// 通过这种方式获取全局 window，因为 script 也是在全局作用域下运行的，所以我们通过 window.proxy 绑定时也必须确保绑定到全局 window 上
	// 否则在嵌套场景下， window.proxy 设置的是内层应用的 window，而代码其实是在全局作用域运行的，会导致闭包里的 window.proxy 取的是最外层的微应用的 proxy
	const globalWindow = (0, eval)('window');
	globalWindow.proxy = proxy;
	// TODO 通过 strictGlobal 方式切换切换 with 闭包，待 with 方式坑趟平后再合并
	return strictGlobal
		? `;(function(window, self){with(window){;${scriptText}\n${sourceUrl}}}).bind(window.proxy)(window.proxy, window.proxy);`
		: `;(function(window, self){;${scriptText}\n${sourceUrl}}).bind(window.proxy)(window.proxy, window.proxy);`;
}

/**
 * 通过 fetch 方法加载指定地址的样式文件
 * @param {*} styles = [ href ]
 * @param {*} fetch 
 * return Promise<Array>，每个元素都是一堆样式内容
 */
export function getExternalStyleSheets(styles, fetch = defaultFetch) {
	return Promise.all(styles.map(styleLink => {
			if (isInlineCode(styleLink)) {
				// if it is inline style
				return getInlineCode(styleLink);
			} else {
				// external styles，加载样式并缓存
				return styleCache[styleLink] ||
					(styleCache[styleLink] = fetch(styleLink).then(response => response.text()));
			}

		},
	));
}

/**
 * 加载脚本，最终返回脚本的内容，Promise<Array>，每个元素都是一段 JS 代码
 * @param {*} scripts = [脚本http地址 or 内联脚本的脚本内容 or { async: true, src: xx }]
 * @param {*} fetch 
 * @param {*} errorCallback 
 */
export function getExternalScripts(scripts, fetch = defaultFetch, errorCallback = () => {
}) {

	// 定义一个可以加载远程指定 url 脚本的方法，当然里面也做了缓存，如果命中缓存直接从缓存中获取
	const fetchScript = scriptUrl => scriptCache[scriptUrl] ||
		(scriptCache[scriptUrl] = fetch(scriptUrl).then(response => {
			// usually browser treats 4xx and 5xx response of script loading as an error and will fire a script error event
			// https://stackoverflow.com/questions/5625420/what-http-headers-responses-trigger-the-onerror-handler-on-a-script-tag/5625603
			if (response.status >= 400) {
				errorCallback();
				throw new Error(`${scriptUrl} load failed with status ${response.status}`);
			}

			return response.text();
		}));

	return Promise.all(scripts.map(script => {

			if (typeof script === 'string') {
				// 字符串，要不是链接地址，要不是脚本内容（代码）
				if (isInlineCode(script)) {
					// if it is inline script
					return getInlineCode(script);
				} else {
					// external script，加载脚本
					return fetchScript(script);
				}
			} else {
				// use idle time to load async script
				// 异步脚本，通过 requestIdleCallback 方法加载
				const { src, async } = script;
				if (async) {
					return {
						src,
						async: true,
						content: new Promise((resolve, reject) => requestIdleCallback(() => fetchScript(src).then(resolve, reject))),
					};
				}

				return fetchScript(src);
			}
		},
	));
}

function throwNonBlockingError(error, msg) {
	setTimeout(() => {
		console.error(msg);
		throw error;
	});
}

const supportsUserTiming =
	typeof performance !== 'undefined' &&
	typeof performance.mark === 'function' &&
	typeof performance.clearMarks === 'function' &&
	typeof performance.measure === 'function' &&
	typeof performance.clearMeasures === 'function';

/**
 * FIXME to consistent with browser behavior, we should only provide callback way to invoke success and error event
 * 脚本执行器，让指定的脚本(scripts)在规定的上下文环境中执行
 * @param entry 入口地址
 * @param scripts = [脚本http地址 or 内联脚本的脚本内容 or { async: true, src: xx }] 
 * @param proxy 脚本执行上下文，全局对象，qiankun JS 沙箱生成 windowProxy 就是传递到了这个参数
 * @param opts
 * @returns {Promise<unknown>}
 */
export function execScripts(entry, scripts, proxy = window, opts = {}) {
	const {
		fetch = defaultFetch, strictGlobal = false, success, error = () => {
		}, beforeExec = () => {
		},
	} = opts;

	// 获取指定的所有外部脚本的内容，并设置每个脚本的执行上下文，然后通过 eval 函数运行
	return getExternalScripts(scripts, fetch, error)
		.then(scriptsText => {
			// scriptsText 为脚本内容数组 => 每个元素是一段 JS 代码
			const geval = (code) => {
				beforeExec();
				(0, eval)(code);
			};

			/**
			 * 
			 * @param {*} scriptSrc 脚本地址
			 * @param {*} inlineScript 脚本内容
			 * @param {*} resolve 
			 */
			function exec(scriptSrc, inlineScript, resolve) {

				// 性能度量
				const markName = `Evaluating script ${scriptSrc}`;
				const measureName = `Evaluating Time Consuming: ${scriptSrc}`;

				if (process.env.NODE_ENV === 'development' && supportsUserTiming) {
					performance.mark(markName);
				}

				if (scriptSrc === entry) {
					// 入口
					noteGlobalProps(strictGlobal ? proxy : window);

					try {
						// bind window.proxy to change `this` reference in script
						geval(getExecutableScript(scriptSrc, inlineScript, proxy, strictGlobal));
						const exports = proxy[getGlobalProp(strictGlobal ? proxy : window)] || {};
						resolve(exports);
					} catch (e) {
						// entry error must be thrown to make the promise settled
						console.error(`[import-html-entry]: error occurs while executing entry script ${scriptSrc}`);
						throw e;
					}
				} else {
					if (typeof inlineScript === 'string') {
						try {
							// bind window.proxy to change `this` reference in script，就是设置 JS 代码的执行上下文，然后通过 eval 函数运行运行代码
							geval(getExecutableScript(scriptSrc, inlineScript, proxy, strictGlobal));
						} catch (e) {
							// consistent with browser behavior, any independent script evaluation error should not block the others
							throwNonBlockingError(e, `[import-html-entry]: error occurs while executing normal script ${scriptSrc}`);
						}
					} else {
						// external script marked with async，异步加载的代码，下载完以后运行
						inlineScript.async && inlineScript?.content
							.then(downloadedScriptText => geval(getExecutableScript(inlineScript.src, downloadedScriptText, proxy, strictGlobal)))
							.catch(e => {
								throwNonBlockingError(e, `[import-html-entry]: error occurs while executing async script ${inlineScript.src}`);
							});
					}
				}

				// 性能度量
				if (process.env.NODE_ENV === 'development' && supportsUserTiming) {
					performance.measure(measureName, markName);
					performance.clearMarks(markName);
					performance.clearMeasures(measureName);
				}
			}

			/**
			 * 递归
			 * @param {*} i 表示第几个脚本
			 * @param {*} resolvePromise 成功回调 
			 */
			function schedule(i, resolvePromise) {

				if (i < scripts.length) {
					// 第 i 个脚本的地址
					const scriptSrc = scripts[i];
					// 第 i 个脚本的内容
					const inlineScript = scriptsText[i];

					exec(scriptSrc, inlineScript, resolvePromise);
					if (!entry && i === scripts.length - 1) {
						// resolve the promise while the last script executed and entry not provided
						resolvePromise();
					} else {
						// 递归调用下一个脚本
						schedule(i + 1, resolvePromise);
					}
				}
			}

			// 从第 0 个脚本开始调度
			return new Promise(resolve => schedule(0, success || resolve));
		});
}

/**
 * 加载指定地址的首屏内容
 * @param {*} url 
 * @param {*} opts 
 * return Promise<{
 * 	// template 是 link 替换为 style 后的 template
		template: embedHTML,
		// 静态资源地址
		assetPublicPath,
		// 获取外部脚本，最终得到所有脚本的代码内容
		getExternalScripts: () => getExternalScripts(scripts, fetch),
		// 获取外部样式文件的内容
		getExternalStyleSheets: () => getExternalStyleSheets(styles, fetch),
		// 脚本执行器，让 JS 代码(scripts)在指定 上下文 中运行
		execScripts: (proxy, strictGlobal) => {
			if (!scripts.length) {
				return Promise.resolve();
			}
			return execScripts(entry, scripts, proxy, { fetch, strictGlobal });
		},
   }>
 */
export default function importHTML(url, opts = {}) {
	// 三个默认的方法
	let fetch = defaultFetch;
	let getPublicPath = defaultGetPublicPath;
	let getTemplate = defaultGetTemplate;

	if (typeof opts === 'function') {
		// if 分支，兼容遗留的 importHTML api，ops 可以直接是一个 fetch 方法
		fetch = opts;
	} else {
		// 用用户传递的参数（如果提供了的话）覆盖默认方法
		fetch = opts.fetch || defaultFetch;
		getPublicPath = opts.getPublicPath || opts.getDomain || defaultGetPublicPath;
		getTemplate = opts.getTemplate || defaultGetTemplate;
	}

	// 通过 fetch 方法请求 url，这也就是 qiankun 为什么要求你的微应用要支持跨域的原因
	return embedHTMLCache[url] || (embedHTMLCache[url] = fetch(url)
		// response.text() 是一个 html 模版
		.then(response => response.text())
		.then(html => {

			// 获取静态资源地址
			const assetPublicPath = getPublicPath(url);
			/**
 	     * 从 html 模版中解析出外部脚本的地址或者内联脚本的代码块 和 link 标签的地址
			 * {
 			 * 	template: 经过处理的脚本，link、script 标签都被注释掉了,
       * 	scripts: [脚本的http地址 或者 { async: true, src: xx } 或者 代码块],
       *  styles: [样式的http地址],
 	     * 	entry: 入口脚本的地址，要不是标有 entry 的 script 的 src，要不就是最后一个 script 标签的 src
 			 * }
			 */
			const { template, scripts, entry, styles } = processTpl(getTemplate(html), assetPublicPath);

			// getEmbedHTML 方法通过 fetch 远程加载所有的外部样式，然后将对应的 link 注释标签替换为 style，即外部样式替换为内联样式，然后返回 embedHTML，即处理过后的 HTML 模版
			return getEmbedHTML(template, styles, { fetch }).then(embedHTML => ({
				// template 是 link 替换为 style 后的 template
				template: embedHTML,
				// 静态资源地址
				assetPublicPath,
				// 获取外部脚本，最终得到所有脚本的代码内容
				getExternalScripts: () => getExternalScripts(scripts, fetch),
				// 获取外部样式文件的内容
				getExternalStyleSheets: () => getExternalStyleSheets(styles, fetch),
				// 脚本执行器，让 JS 代码(scripts)在指定 上下文 中运行
				execScripts: (proxy, strictGlobal) => {
					if (!scripts.length) {
						return Promise.resolve();
					}
					return execScripts(entry, scripts, proxy, { fetch, strictGlobal });
				},
			}));
		}));
}

/**
 * 加载指定地址的首屏内容
 * @param {*} entry 可以是一个字符串格式的地址，比如 localhost:8080，也可以是一个配置对象，比如 { scripts, styles, html }
 * @param {*} opts
 * return importHTML 的执行结果
 */
export function importEntry(entry, opts = {}) {
	// 从 opt 参数中解析出 fetch 方法 和 getTemplate 方法，没有就用默认的
	const { fetch = defaultFetch, getTemplate = defaultGetTemplate } = opts;
	// 获取静态资源地址的一个方法
	const getPublicPath = opts.getPublicPath || opts.getDomain || defaultGetPublicPath;

	if (!entry) {
		throw new SyntaxError('entry should not be empty!');
	}

	// html entry，entry 是一个字符串格式的地址
	if (typeof entry === 'string') {
		return importHTML(entry, { fetch, getPublicPath, getTemplate });
	}

	// config entry，entry 是一个对象 = { scripts, styles, html }
	if (Array.isArray(entry.scripts) || Array.isArray(entry.styles)) {

		const { scripts = [], styles = [], html = '' } = entry;
		const setStylePlaceholder2HTML = tpl => styles.reduceRight((html, styleSrc) => `${genLinkReplaceSymbol(styleSrc)}${html}`, tpl);
		const setScriptPlaceholder2HTML = tpl => scripts.reduce((html, scriptSrc) => `${html}${genScriptReplaceSymbol(scriptSrc)}`, tpl);

		return getEmbedHTML(getTemplate(setScriptPlaceholder2HTML(setStylePlaceholder2HTML(html))), styles, { fetch }).then(embedHTML => ({
			template: embedHTML,
			assetPublicPath: getPublicPath(entry),
			getExternalScripts: () => getExternalScripts(scripts, fetch),
			getExternalStyleSheets: () => getExternalStyleSheets(styles, fetch),
			execScripts: (proxy, strictGlobal) => {
				if (!scripts.length) {
					return Promise.resolve();
				}
				return execScripts(scripts[scripts.length - 1], scripts, proxy, { fetch, strictGlobal });
			},
		}));

	} else {
		throw new SyntaxError('entry scripts or styles should be array!');
	}
}
