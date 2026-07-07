import getReadingTime from 'reading-time';
import { toString } from 'mdast-util-to-string';

// Build-time remark plugin: compute reading time from the post body and expose it
// on frontmatter as `minutesRead` (available via render()'s remarkPluginFrontmatter).
export function remarkReadingTime() {
  return function (tree, { data }) {
    const textOnPage = toString(tree);
    const readingTime = getReadingTime(textOnPage);
    data.astro.frontmatter.minutesRead = readingTime.text; // e.g. "2 min read"
  };
}
