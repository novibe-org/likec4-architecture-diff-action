#!/usr/bin/env node
// Usage: architecture-diff.mjs <base dir> <head dir>, each holding model.json and mermaid/ from LikeC4.
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const MARKER = '<!-- architecture-diff -->'
const LIMIT = 60000
// Okabe-Ito, which colour-blind readers tell apart; each keeps 3:1 on GitHub's light and dark, as Mermaid there cannot pick colours by theme.
const DEFAULT = { added: '#0072B2', changed: '#B07D00', removed: '#CC79A7' }
const STROKE = Object.fromEntries(Object.entries(DEFAULT).map(([state, colour]) => {
  const given = process.env[`${state.toUpperCase()}_COLOR`] || colour
  if (!/^#[0-9a-f]{6}$/i.test(given)) throw new Error(`${state}-color is ${given}; give a hex colour such as ${colour}`)
  return [state, given]
}))
const FILL = Object.fromEntries(Object.entries(STROKE).map(([state, colour]) => [state, `${colour}33`]))
// A cue that is not colour, so the diff reads in greyscale too.
const LINE = { added: 'stroke-width:3px', changed: 'stroke-width:4px', removed: 'stroke-width:3px,stroke-dasharray:6 4' }
const look = state => `stroke:${STROKE[state]},${LINE[state]}`
const AREA = '#8c959f1f'
const EMPTY = { elements: {}, relations: {}, deployments: { elements: {} }, views: {} }

const [baseDir, headDir] = process.argv.slice(2)
// With a likec4.config, the export is a list of projects, and may list one project more than once.
const load = dir => {
  if (!existsSync(`${dir}/model.json`)) return EMPTY
  const model = JSON.parse(readFileSync(`${dir}/model.json`, 'utf8'))
  if (!Array.isArray(model)) return model
  const projects = [...new Set(model.map(p => p.projectId))]
  if (projects.length > 1) throw new Error(`${dir} holds the LikeC4 projects ${projects.join(', ')}; point path at one of them`)
  return model[0] ?? EMPTY
}
const base = load(baseDir)
const head = load(headDir)

const props = e => JSON.stringify([e.kind, e.title, e.description, e.summary, e.technology, e.tags, e.style, e.links, e.metadata, e.element])
const relKey = r => [r.source.model ?? r.source.deployment, r.target.model ?? r.target.deployment, r.kind ?? ''].join(' ')
const relProps = r => JSON.stringify([r.title, r.description, r.technology, r.tags, r.links, r.metadata, r.line, r.color])

const changedElements = new Set()
for (const kind of ['elements', 'deployments']) {
  const before = kind === 'elements' ? base.elements : base.deployments?.elements ?? {}
  const after = kind === 'elements' ? head.elements : head.deployments?.elements ?? {}
  for (const [id, e] of Object.entries(after)) if (before[id] && props(before[id]) !== props(e)) changedElements.add(id)
}

const relationsOf = model => [...Object.values(model.relations), ...Object.values(model.deployments?.relations ?? {})]
const pairOf = new Map()
const changedRelations = new Set()
const pool = relationsOf(base)
const unpaired = []
for (const r of relationsOf(head)) {
  const same = pool.findIndex(b => relKey(b) === relKey(r) && relProps(b) === relProps(r))
  if (same >= 0) pairOf.set(pool.splice(same, 1)[0].id, r.id)
  else unpaired.push(r)
}
for (const r of unpaired) {
  const near = pool.findIndex(b => relKey(b) === relKey(r))
  if (near < 0) continue
  changedRelations.add(r.id)
  pairOf.set(pool.splice(near, 1)[0].id, r.id)
}

const nodeRef = n => n.deploymentRef ?? n.modelRef ?? n.id
const relationRefs = (e, side) => e.relations.map(id => (side === 'head' ? id : pairOf.get(id) ?? `base:${id}`))
const nodeLook = n => JSON.stringify([n.kind, n.title, n.description, n.technology, n.color, n.shape, n.style, n.tags])
const edgeLook = e => JSON.stringify([e.label, e.color, e.line, e.head, e.tail])

// A view's state per node and edge: present only in one version, or present in both with changed content.
function marks(view, other, side) {
  const own = side === 'after' ? 'head' : 'base'
  const otherNodes = new Map(other?.nodes.map(n => [nodeRef(n), n]) ?? [])
  const otherEdges = new Map(other?.edges.flatMap(e => relationRefs(e, own === 'head' ? 'base' : 'head').map(r => [r, e])) ?? [])
  const gone = side === 'after' ? 'added' : 'removed'
  const nodes = new Map()
  for (const n of view.nodes) {
    const before = otherNodes.get(nodeRef(n))
    if (!before) nodes.set(n.id, gone)
    else if (side === 'after' && ([n.modelRef, n.deploymentRef, n.id].some(id => changedElements.has(id)) || nodeLook(before) !== nodeLook(n))) nodes.set(n.id, 'changed')
  }
  const edges = new Map()
  for (const e of view.edges) {
    const refs = relationRefs(e, own)
    const found = refs.filter(r => otherEdges.has(r))
    if (!found.length) edges.set(e.id, gone)
    else if (side === 'after' && (found.length < refs.length || otherEdges.get(found[0]).relations.length !== refs.length
      || e.relations.some(id => changedRelations.has(id)) || edgeLook(otherEdges.get(found[0])) !== edgeLook(e))) edges.set(e.id, 'changed')
  }
  return { nodes, edges }
}

const pascal = s => s.split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('')
function mermaidIds(view) {
  const byId = new Map(view.nodes.map(n => [n.id, n]))
  const ids = new Map()
  const of = n => {
    if (!ids.has(n.id)) {
      const parent = n.parent && byId.get(n.parent)
      ids.set(n.id, parent ? `${of(parent)}.${pascal(n.id.slice(parent.id.length + 1))}` : pascal(n.id))
    }
    return ids.get(n.id)
  }
  view.nodes.forEach(of)
  return ids
}

function styled(view, text, { nodes, edges }, unmatched, extra = new Set()) {
  const ids = mermaidIds(view)
  // A long label wraps over lines, so labels are dropped before links are read line by line.
  const unlabelled = text.replace(/"`[\s\S]*?`"/g, '""')
  const links = unlabelled.split('\n').filter(l => /^\s*\S+\s+-.*->\s+\S+\s*$/.test(l)).map(l => l.trim().split(/\s+/))
  const taken = new Set()
  const containers = new Set([...view.nodes.filter(n => n.children?.length).map(n => n.id), ...extra])
  const lines = [text]
  // Mermaid fills a subgraph and borders it olive in its light theme, which reads as the changed tint.
  for (const id of containers) if (!nodes.has(id) && text.includes(ids.get(id))) lines.push(`  style ${ids.get(id)} fill:${AREA},stroke:#8c959f`)
  for (const [id, state] of nodes) {
    const fill = containers.has(id) ? `fill:${AREA},` : `fill:${FILL[state]},`
    if (!text.includes(ids.get(id))) unmatched.push(`${view.id}: ${id}`)
    else lines.push(`  style ${ids.get(id)} ${fill}${look(state)}`)
  }
  for (const e of view.edges) {
    const at = links.findIndex((l, i) => !taken.has(i) && l[0] === ids.get(e.source) && l.at(-1) === ids.get(e.target))
    if (at >= 0) taken.add(at)
    if (!edges.has(e.id)) continue
    if (at < 0) unmatched.push(`${view.id}: ${e.source} -> ${e.target}`)
    else lines.push(`  linkStyle ${at} ${look(edges.get(e.id))}`)
  }
  return lines
}

// A swatch only for a default colour, as an emoji cannot show one given as an input.
const swatch = (state, emoji) => (STROKE[state] === DEFAULT[state] ? `${emoji} ` : '')
const fence = lines => lines.join('\n').replaceAll('```', "'''")

// A Mermaid statement can span lines, as a long label wraps; it ends where its labels close.
function statements(text) {
  const out = []
  let open = ''
  for (const line of text.split('\n')) {
    open = open ? `${open}\n${line}` : line
    if ((open.match(/`/g) ?? []).length % 2 === 0) out.push(open), (open = '')
  }
  return out
}
const linkEnds = s => {
  const bare = s.replace(/"`[\s\S]*?`"/g, '""').trim()
  return /^\S+\s+-.*->\s+\S+$/.test(bare) ? [bare.split(/\s+/)[0], bare.split(/\s+/).at(-1)] : null
}

// The pull request's diagram of a view, with what it removed from the base's diagram put back in.
function combined(h, b, headText, baseText, added, removed, unmatched) {
  const headIds = mermaidIds(h)
  const baseIds = mermaidIds(b)
  const headByRef = new Map(h.nodes.map(n => [nodeRef(n), n]))
  const headById = new Map(h.nodes.map(n => [n.id, n]))
  const baseById = new Map(b.nodes.map(n => [n.id, n]))
  const lines = headText.split('\n')
  const baseStatements = statements(baseText)
  const restored = new Map()
  const idIn = n => (headByRef.has(nodeRef(n)) ? headIds.get(headByRef.get(nodeRef(n)).id) : restored.get(n.id))
  const containers = new Set()
  const styles = []

  // A removed child goes back into its parent; a parent the pull request shows as a leaf becomes a container again.
  const insert = (parent, placed) => {
    const parentId = parent && idIn(parent)
    let at = parentId ? lines.findIndex(l => l.trimStart().startsWith(`subgraph ${parentId}[`)) : -1
    if (parentId && at < 0) {
      at = lines.findIndex(l => l.trimStart().startsWith(`${parentId}@{`))
      if (at >= 0) {
        const indent = lines[at].match(/^\s*/)[0]
        const label = lines[at].match(/label: "(.*)" \}\s*$/)?.[1] ?? parentId
        lines.splice(at, 1, `${indent}subgraph ${parentId}["\`${label}\`"]`, `${indent}end`)
        if (headByRef.has(nodeRef(parent))) containers.add(headByRef.get(nodeRef(parent)).id)
      }
    }
    if (at < 0) return lines.push(...placed.map(l => `  ${l}`))
    const outer = lines[at].match(/^\s*/)[0]
    lines.splice(lines.indexOf(`${outer}end`, at), 0, ...placed.map(l => `${outer}  ${l}`))
  }

  const depth = n => (n.parent && baseById.has(n.parent) ? depth(baseById.get(n.parent)) + 1 : 0)
  const gone = b.nodes.filter(n => removed.nodes.get(n.id) === 'removed').sort((x, y) => depth(x) - depth(y))
  const used = new Set(headIds.values())
  for (const n of gone) {
    let id = baseIds.get(n.id)
    while (used.has(id)) id += 'Removed'
    used.add(id)
    restored.set(n.id, id)
  }
  for (const n of gone) {
    const own = baseIds.get(n.id)
    const at = baseStatements.findIndex(s => new RegExp(`^\\s*(subgraph )?${own.replaceAll('.', '\\.')}[@\\[]`).test(s))
    if (at < 0) {
      unmatched.push(`${b.id}: ${n.id}`)
      continue
    }
    const declared = baseStatements[at].trim().replace(own, restored.get(n.id))
    const container = declared.startsWith('subgraph')
    insert(n.parent && baseById.get(n.parent), container ? [declared, 'end'] : [declared])
    styles.push(`  style ${restored.get(n.id)} fill:${container ? AREA : FILL.removed},${look('removed')}`)
  }

  const baseLinks = baseStatements.filter(linkEnds)
  const taken = new Set()
  const lineOf = new Map()
  for (const e of b.edges) {
    const at = baseLinks.findIndex((s, i) => !taken.has(i) && linkEnds(s)[0] === baseIds.get(e.source) && linkEnds(s)[1] === baseIds.get(e.target))
    if (at >= 0) taken.add(at), lineOf.set(e.id, baseLinks[at])
  }
  // Relationships rolled up into one arrow: one replaced by another between the same two boxes is one arrow,
  // paired first with an arrow that looks the same.
  const goneEdges = b.edges.filter(e => removed.edges.get(e.id) === 'removed')
  const sameEnds = (t, e) => nodeRef(headById.get(t.source)) === nodeRef(baseById.get(e.source))
    && nodeRef(headById.get(t.target)) === nodeRef(baseById.get(e.target))
  const twins = new Set()
  const merged = new Set()
  for (const alike of [true, false]) {
    for (const e of goneEdges) {
      if (merged.has(e.id)) continue
      const twin = h.edges.find(t => added.edges.get(t.id) === 'added' && !twins.has(t.id) && sameEnds(t, e) && (!alike || edgeLook(t) === edgeLook(e)))
      if (!twin) continue
      twins.add(twin.id)
      merged.add(e.id)
      if (alike) added.edges.delete(twin.id)
      else added.edges.set(twin.id, 'changed')
    }
  }
  let links = statements(lines.join('\n')).filter(linkEnds).length
  for (const e of goneEdges) {
    if (merged.has(e.id)) continue
    const s = lineOf.get(e.id)?.trim()
    const ends = [idIn(baseById.get(e.source)), idIn(baseById.get(e.target))]
    if (!s || ends.includes(undefined)) {
      unmatched.push(`${b.id}: ${e.source} -> ${e.target}`)
      continue
    }
    const [from, to] = linkEnds(s)
    lines.push(`  ${ends[0]}${s.slice(from.length, s.length - to.length)}${ends[1]}`)
    styles.push(`  linkStyle ${links++} ${look('removed')}`)
  }
  return { text: lines.join('\n'), styles, containers }
}

const out = [MARKER, '## Architecture diff', '']
// LikeC4 writes each view's diagram under the folder of the file that defines the view.
const diagrams = dir => {
  const root = `${dir}/mermaid`
  if (!existsSync(root)) return {}
  const files = readdirSync(root, { recursive: true }).filter(f => f.endsWith('.mmd'))
  return Object.fromEntries(files.map(f => [f.split('/').at(-1).slice(0, -'.mmd'.length), `${root}/${f}`]))
}
const diagramOf = { [headDir]: diagrams(headDir), [baseDir]: diagrams(baseDir) }

const sections = []
const unmatched = []
for (const id of [...new Set([...Object.keys(base.views), ...Object.keys(head.views)])].sort()) {
  const h = head.views[id]
  const b = base.views[id]
  const parts = []
  const headFile = h && diagramOf[headDir][id]
  const baseFile = b && diagramOf[baseDir][id]
  const added = h && headFile && marks(h, b, 'after')
  const removed = b && baseFile && marks(b, h, 'before')
  const any = m => m && (m.nodes.size || m.edges.size)
  if (h && headFile && b && baseFile && any(removed)) {
    const { text, styles, containers } = combined(h, b, readFileSync(headFile, 'utf8').trimEnd(), readFileSync(baseFile, 'utf8').trimEnd(), added, removed, unmatched)
    if (styles.length || any(added)) parts.push('```mermaid', fence([...styled(h, text, added, unmatched, containers), ...styles]), '```', '')
  } else if (any(added)) {
    parts.push('```mermaid', fence(styled(h, readFileSync(headFile, 'utf8').trimEnd(), added, unmatched)), '```', '')
  } else if (!h && any(removed)) {
    parts.push('```mermaid', fence(styled(b, readFileSync(baseFile, 'utf8').trimEnd(), removed, unmatched)), '```', '')
  }
  const retitled = h && b && JSON.stringify([h.title, h.description]) !== JSON.stringify([b.title, b.description])
  if (retitled && !parts.length) parts.push('The view\'s title or description changed.', '')
  if (parts.length) sections.push([id, [`### \`${id}\` — ${!b ? 'new view' : !h ? 'view removed' : 'changed'}`, '', ...parts].join('\n')])
}

if (!sections.length) {
  out.push('No view of the architecture model changed.')
} else {
  out.push(`${sections.length} of ${new Set([...Object.keys(base.views), ...Object.keys(head.views)]).size} views changed · ${swatch('added', '🟦')}added · ${swatch('changed', '🟨')}changed, thick border · ${swatch('removed', '🟪')}removed, dashed`, '')
  let size = out.join('\n').length
  for (const [n, [, text]] of sections.entries()) {
    if (size + text.length > LIMIT) {
      out.push(`…and ${sections.length - n} more: ${sections.slice(n).map(([id]) => `\`${id}\``).join(', ')}.`)
      break
    }
    out.push(text)
    size += text.length
  }
}
for (const u of unmatched) console.error(`::warning::architecture-diff could not mark ${u} in the Mermaid output`)
console.log(out.join('\n'))
