export function captureBoardScrollPositions(document) {
  const positions = new Map()
  const page = document?.scrollingElement
  if (page) positions.set('page', readPosition(page))
  for (const element of document?.querySelectorAll?.('[data-scroll-key]') ?? []) {
    const key = element.dataset?.scrollKey
    if (key) positions.set(key, readPosition(element))
  }
  return positions
}

export function restoreBoardScrollPositions(document, positions) {
  const page = document?.scrollingElement
  const pagePosition = positions?.get('page')
  if (page && pagePosition) writePosition(page, pagePosition)
  for (const element of document?.querySelectorAll?.('[data-scroll-key]') ?? []) {
    const key = element.dataset?.scrollKey
    const position = key ? positions?.get(key) : undefined
    if (position) writePosition(element, position)
  }
}

export function diagnosticScrollKey(backendGeneration, record) {
  return `diagnostic:${backendGeneration}:${record.seq}`
}

function readPosition(element) {
  const top = element.getBoundingClientRect?.().top
  const anchor = [...(element.querySelectorAll?.('[data-seq]') ?? [])].find(item => {
    const rect = item.getBoundingClientRect()
    return item.closest?.('[data-scroll-key]') === element && rect.height > 0 && rect.bottom > top
  })
  return {top: element.scrollTop, left: element.scrollLeft,
    ...(anchor ? {seq: anchor.dataset.seq, offset: anchor.getBoundingClientRect().top - top} : {})}
}

function writePosition(element, position) {
  element.scrollTop = position.top
  if (position.seq !== undefined) {
    const anchor = element.querySelector?.(`[data-seq="${position.seq}"]`)
    if (anchor) element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - position.offset
  }
  element.scrollLeft = position.left
}
