// One stroke-style 24×24 set shared by workbench controls. The CSP only allows
// inline SVG, so icons are built as nodes; without a DOM (unit stubs) they are absent.
const PATHS=Object.freeze({
 play:'M7 4.5l12 7.5-12 7.5z',
 stop:'M6.5 6.5h11v11h-11z',
 pause:'M8.5 5v14M15.5 5v14',
 list:'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
 shield:'M12 3l8 3v6c0 4.6-3.3 7.8-8 9-4.7-1.2-8-4.4-8-9V6zM8.5 12l2.5 2.5 4.5-5',
 alert:'M12 3.5l9.5 16.5h-19zM12 10v4.5M12 17.5h.01',
 refresh:'M20 11a8 8 0 1 0-2.4 5.6M20 4.5V11h-6.5',
 search:'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20.5 20.5l-4.2-4.2',
 monitor:'M4 5h16v11H4zM9 20h6M12 16v4',
 globe:'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5s1.1-6.1 3.5-8.5z',
 camera:'M4 8h3l1.5-2.5h7L17 8h3v11H4zM12 10.5a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5z',
 code:'M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5M13.5 5l-3 14',
 book:'M5 4.5h10.5a3 3 0 0 1 3 3V19.5H8a3 3 0 0 1-3-3zM5 16.5a3 3 0 0 1 3-3h10.5',
 plug:'M9 3.5v5M15 3.5v5M6.5 8.5h11v3.5a5.5 5.5 0 0 1-11 0zM12 17.5v3',
})
export function iconNode(name,document=globalThis.document){
 const d=PATHS[name]
 if(!d||!document?.createElementNS)return null
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS('http://www.w3.org/2000/svg','path')
 svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('class','ui-icon');path.setAttribute('d',d);svg.append(path);return svg
}
/** Puts an icon in front of a button's existing label. */
export function withIcon(button,name,document=globalThis.document){
 const icon=iconNode(name,document)
 if(icon){button.prepend(icon);button.classList.add('has-icon')}
 return button
}
