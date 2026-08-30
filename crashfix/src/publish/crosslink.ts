/** Build per-repo PR bodies: base body plus a "Companion PRs" footer listing
 *  the other repos' PRs. Single PR → just the base body. */
export function crossLinkBodies(
  prs: { repo: string; url: string }[],
  baseBody: string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const pr of prs) {
    const others = prs.filter((o) => o.repo !== pr.repo);
    out.set(
      pr.repo,
      others.length
        ? `${baseBody}\n\n---\n**Companion PRs:** ${others
            .map((o) => `${o.repo}: ${o.url}`)
            .join(' · ')}`
        : baseBody,
    );
  }
  return out;
}
