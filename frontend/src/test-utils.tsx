import axe from 'axe-core'

/** Runs axe-core on a rendered container. `color-contrast` is skipped because jsdom has no layout/colour engine;
 *  contrast is checked in the real-browser Playwright run instead. */
export async function a11yViolations(container: Element): Promise<string[]> {
  const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
  return res.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s)) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)
}
