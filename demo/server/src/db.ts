let count = 0

export const db = {
  getCount() {
    return count
  },
  increment() {
    count += 1
    return count
  },
}
