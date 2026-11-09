// Popups, headless: what a page's window.open or link becomes (a tab, a background tab, a popup card, nothing), how
// a card is sized and kept inside the pane, and the bar's host line. The real thing, in the app against the fixture
// site: test/live/browser-oauth.js.
// Run: npm run build && node test/browser-popups.js
const path = require('node:path');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const popups = require(path.join(projectDir, 'dist/main/browser/popups.js'));
const { check, done } = require('./support/check.js');

const { popupDecision, parseFeatures, requestedSize, popupBounds, movedBounds, refitBounds, hostOf, MAX_POPUPS, POPUP_BAR, DEFAULT_POPUP_SIZE, popupBarHtml } = popups;

const decide = (disposition, features = '', url = 'https://example.com/x', openPopups = 0) => popupDecision({ disposition, features, url, openPopups });

// ---------- 1. The decision ----------
check('1: a plain link with target=_blank (foreground-tab) is a tab', decide('foreground-tab') === 'tab');
check('1: a ⌘-click or middle click (background-tab) is a background tab', decide('background-tab') === 'background-tab');
check('1: window.open with a width and height (new-window) is a popup', decide('new-window', 'width=420,height=560') === 'popup');
check('1: a width alone, or a height alone, is still a popup', decide('new-window', 'width=500') === 'popup' && decide('new-window', 'height=300,popup') === 'popup');
check('1: innerWidth/innerHeight count as a size too', decide('new-window', 'innerWidth=400,innerHeight=300') === 'popup');
check('1: new-window without a size is a tab', decide('new-window', '') === 'tab' && decide('new-window', 'noopener,noreferrer') === 'tab' && decide('new-window', 'popup') === 'tab');
check('1: default and other dispositions follow the same rule', decide('default', '') === 'tab' && decide('default', 'width=300,height=300') === 'popup' && decide('other', '') === 'tab');
check(`1: a fourth popup while ${MAX_POPUPS} are open is refused`, decide('new-window', 'width=400,height=400', 'https://a.example/', MAX_POPUPS) === 'deny');
check('1: … but the third is not', decide('new-window', 'width=400,height=400', 'https://a.example/', MAX_POPUPS - 1) === 'popup');
check('1: the cap does not touch tabs', decide('foreground-tab', '', 'https://a.example/', 9) === 'tab' && decide('background-tab', '', 'https://a.example/', 9) === 'background-tab');
check('1: a javascript: URL is refused whatever the disposition', decide('new-window', 'width=300,height=300', 'javascript:alert(1)') === 'deny' && decide('foreground-tab', '', ' javascript:void 0') === 'deny' && decide('background-tab', '', 'JavaScript:x') === 'deny');
check('1: about:blank with a size is a popup (the OAuth libraries open blank, then navigate)', decide('new-window', 'width=500,height=600', 'about:blank') === 'popup');

// ---------- 2. Features ----------
check('2: features parse by comma and space, case-insensitive, bare tokens true', JSON.stringify(parseFeatures('Width=400, height=500 popup noopener=1')) === JSON.stringify({ width: '400', height: '500', popup: '1', noopener: '1' }));
check('2: the requested size, rounded, odd values ignored', JSON.stringify(requestedSize('width=400.6,height=abc')) === JSON.stringify({ width: 401 }) && JSON.stringify(requestedSize('height=-5,width=0')) === '{}' && JSON.stringify(requestedSize('')) === '{}');

// ---------- 3. Where a card goes ----------
const pane = { x: 700, y: 120, width: 600, height: 700 };
let b = popupBounds({ width: 420, height: 560 }, pane);
check(`3: the requested size, centred over the pane with the ${POPUP_BAR} px bar above the page area`, b.width === 420 && b.height === 560 && b.x === 700 + 90 && b.y === 120 + Math.round((700 - 592) / 2) + POPUP_BAR, b);
b = popupBounds({}, pane);
check(`3: no size asked: ${DEFAULT_POPUP_SIZE.width}×${DEFAULT_POPUP_SIZE.height}, centred with its bar`, b.width === 480 && b.height === 640 && b.x === 760 && b.y === 120 + Math.round((700 - 672) / 2) + POPUP_BAR, b);
b = popupBounds({ width: 2000, height: 2000 }, pane);
check('3: a huge request fills the pane and no more', b.width === 600 && b.height === 700 - POPUP_BAR && b.x === 700 && b.y === 120 + POPUP_BAR, b);
b = popupBounds({ width: 420, height: 560 }, { x: 0, y: 0, width: 0, height: 0 });
check('3: a pane without a size yet places the card at the requested size', b.width === 420 && b.height === 560, b);
const card = { x: 790, y: 206, width: 420, height: 560 };
let m = movedBounds(card, 850, 200, pane);
check('3: a drag moves the card (the bar\'s corner at x, y) inside the pane', m.x === 850 && m.y === 200 + POPUP_BAR && m.width === 420 && m.height === 560, m);
m = movedBounds(card, 5000, -5000, pane);
check('3: … and never out of it', m.x === 700 + 600 - 420 && m.y === 120 + POPUP_BAR, m);
m = movedBounds(card, -5000, 5000, pane);
check('3: … on any side', m.x === 700 && m.y === 120 + 700 - 560, m);
const r = refitBounds(card, { x: 100, y: 100, width: 300, height: 400 });
check('3: a smaller pane shrinks and moves the card to fit', r.width === 300 && r.height === 400 - POPUP_BAR && r.x === 100 && r.y === 100 + POPUP_BAR, r);
check('3: a pane without a size leaves the card as it is', JSON.stringify(refitBounds(card, { x: 0, y: 0, width: 0, height: 0 })) === JSON.stringify(card));

// ---------- 4. The bar ----------
check('4: the host line names the host of a web page, nothing for about:blank, the scheme otherwise', hostOf('https://accounts.example.com/signin?x=1') === 'accounts.example.com' && hostOf('about:blank') === '' && hostOf('file:///a/b.html') === 'file' && hostOf('not a url') === '');
const html = popupBarHtml(false);
check('4: the bar page has the title, the host, the × and the drag handling', /id="title"/.test(html) && /id="host"/.test(html) && /aria-label="Close popup"/.test(html) && /pointerdown/.test(html) && /bar\.act\('close'\)/.test(html));
check('4: light and dark bars differ in their colours only', popupBarHtml(true) !== html && popupBarHtml(true).replace(/#[0-9a-f]{6}|rgba\([^)]*\)/gi, '').length === html.replace(/#[0-9a-f]{6}|rgba\([^)]*\)/gi, '').length);

done();
