/** Messages reserve space above the orb; task cards reserve their own space below. */
export function createTaskAreaReservation({reserve, onLayout}) {
  let taskRows = 0, progressRows = 0, queue = Promise.resolve()
  function request() {
    const next = queue.then(async () => {
      const layout = await reserve(progressRows, taskRows)
      onLayout(layout)
      return layout
    })
    queue = next.catch(() => {})
    return next
  }
  return Object.freeze({
    reserveBanner(rows) { taskRows = rows; return request() },
    reserveProgress(rows) { progressRows = rows; return request() },
    onNativeLayout: onLayout,
  })
}
