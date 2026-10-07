// The function that reads a Shironet page inside the browser. It returns plain JSON
// (an ExtractedPage); the browser has already decoded the charset and HTML entities.
// Text rule (matches the Python parser): raw newlines become spaces, <br> becomes '\n';
// Node collapses spaces per line afterwards (shironet.ts).

export const EXTRACT_SOURCE = `(() => {
  const textOf = (element) => {
    if (!element) return '';
    let out = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) out += child.nodeValue.replace(/[\\r\\n]/g, ' ');
        else if (child.nodeType === 1) {
          if (child.tagName === 'BR') out += '\\n';
          else walk(child);
        }
      }
    };
    walk(element);
    return out;
  };
  const lyricsElement = document.querySelector('span.artist_lyrics_text');
  const links = [...document.querySelectorAll('a.search_link_name_big')];
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  const hasContent = !!lyricsElement || links.length > 0;
  // Every real Shironet page (the home page too) loads the bot-manager script, so the
  // script alone is no sign of a challenge; a page with Shironet's own title is not one.
  const shironetTitle = document.title.includes('שירונט');
  // Search pages show 10 results; the paging bar ends with a "הבא >>" (next) link.
  const nextLink = [...document.querySelectorAll('a.search_nav_bar')].find((a) => a.textContent.includes('הבא'));
  return {
    url: location.href,
    title: document.title,
    challenge: location.hostname.endsWith('perfdrive.com')
      || /radware/i.test(document.title)
      || (html.includes('perfdrive.com') && !hasContent && !shironetTitle),
    links: links.map((a) => ({ text: textOf(a), href: a.getAttribute('href') })),
    nextPageHref: nextLink ? nextLink.getAttribute('href') : null,
    lyrics: lyricsElement ? {
      song: textOf(document.querySelector('h1.artist_song_name_txt')),
      singer: textOf(document.querySelector('a.artist_singer_title')),
      text: textOf(lyricsElement),
    } : null,
  };
})()`;
