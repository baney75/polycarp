import Foundation

/// Work on several apps' windows at once: one lane per app, so a slow app holds up only its own windows, and the calls to
/// one app stay one at a time and in order.
public enum Lanes {
    /// The indices of `keys`, one lane per key, each lane in the order given.
    public static func split<Key: Hashable>(_ keys: [Key]) -> [[Int]] {
        var lane: [Key: Int] = [:]
        var out: [[Int]] = []
        for (i, key) in keys.enumerated() {
            if let n = lane[key] {
                out[n].append(i)
            } else {
                lane[key] = out.count
                out.append([i])
            }
        }
        return out
    }

    /// Does `work` on every item, lanes side by side, and waits for all of them. The answers are in the items' order.
    public static func map<Item, Key: Hashable, Answer>(_ items: [Item], by key: (Item) -> Key, _ work: (Item) -> Answer) -> [Answer] {
        let lanes = split(items.map(key))
        var out = [Answer?](repeating: nil, count: items.count)
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: lanes.count) { n in
            for i in lanes[n] {
                let answer = work(items[i])
                lock.lock(); out[i] = answer; lock.unlock()
            }
        }
        return out.map { $0! }
    }
}
