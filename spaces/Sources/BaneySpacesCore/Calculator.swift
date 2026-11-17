import Foundation

/// Sums and unit conversions typed into the launcher: `12*7`, `2^10`, `sqrt(2)`, `15% * 80`,
/// `5 km in mi`, `72 f to c`. A plain number or word is never a sum, so `3` still goes to
/// workspace 3 and `safari` still finds Safari.
public enum Calculator {
    public struct Answer: Equatable, Sendable {
        public let value: Double
        /// The unit the answer is in, for a conversion.
        public let unit: String?
        /// What Return copies: the number alone, never grouped.
        public var copyText: String { Calculator.format(value) }
        /// What the row shows.
        public var display: String { unit.map { "\(copyText) \($0)" } ?? copyText }
    }

    /// The answer to what was typed, or nil when it isn't a sum or a conversion.
    public static func evaluate(_ text: String) -> Answer? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, t.count <= 200 else { return nil }
        if let c = Units.convert(t) { return c }
        var p = Parser(t)
        guard let v = p.parseAll(), p.sawWork, v.isFinite else { return nil }
        return Answer(value: v, unit: nil)
    }

    /// Up to 10 significant digits, no grouping; whole numbers below 10^15 in full.
    public static func format(_ v: Double) -> String {
        let v = v == 0 ? 0 : v // no "-0"
        if v.rounded() == v, abs(v) < 1e15 { return String(Int64(v)) }
        var s = String(format: "%.10g", v)
        if s.contains("e") { return s }
        if s.contains(".") {
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        return s
    }

    /// The numeric part of a conversion's left side: a number or a sum.
    static func number(_ text: String) -> Double? {
        var p = Parser(text)
        guard let v = p.parseAll(), v.isFinite else { return nil }
        return v
    }

    // MARK: Parser

    /// expr := term (('+'|'-') term)*; term := unary (('*'|'/'|mod) unary)*;
    /// unary := ('+'|'-') unary | power; power := postfix ('^' unary)?;
    /// postfix := primary '%'*; primary := number | constant | function '(' expr ')' | '(' expr ')'.
    /// A number or ')' followed by '(' or a constant multiplies: `2pi`, `3(4+5)`.
    struct Parser {
        private let chars: [Character]
        private var i = 0
        /// An operator or a function was used: the text is a sum, not a bare number.
        private(set) var sawWork = false

        init(_ text: String) { chars = Array(text) }

        static let functions: [String: (Double) -> Double] = [
            "sqrt": { $0.squareRoot() }, "cbrt": { Foundation.cbrt($0) }, "abs": { Swift.abs($0) },
            "round": { $0.rounded() }, "floor": { Foundation.floor($0) }, "ceil": { Foundation.ceil($0) },
            "ln": { Foundation.log($0) }, "log": { Foundation.log10($0) }, "log2": { Foundation.log2($0) },
            "exp": { Foundation.exp($0) },
            "sin": { Foundation.sin($0) }, "cos": { Foundation.cos($0) }, "tan": { Foundation.tan($0) },
            "asin": { Foundation.asin($0) }, "acos": { Foundation.acos($0) }, "atan": { Foundation.atan($0) },
        ]
        static let constants: [String: Double] = ["pi": Double.pi, "π": Double.pi, "e": M_E, "tau": 2 * Double.pi]

        mutating func parseAll() -> Double? {
            guard let v = expr() else { return nil }
            skipSpace()
            return i == chars.count ? v : nil
        }

        private mutating func skipSpace() { while i < chars.count, chars[i] == " " { i += 1 } }

        private mutating func peek() -> Character? {
            skipSpace()
            return i < chars.count ? chars[i] : nil
        }

        private mutating func expr() -> Double? {
            guard var v = term() else { return nil }
            while let c = peek(), c == "+" || c == "-" || c == "−" {
                i += 1
                sawWork = true
                guard let r = term() else { return nil }
                v = c == "+" ? v + r : v - r
            }
            return v
        }

        private mutating func term() -> Double? {
            guard var v = unary() else { return nil }
            while true {
                guard let c = peek() else { return v }
                if c == "*" || c == "/" || c == "×" || c == "÷" || c == "·" {
                    i += 1
                } else if word(at: i) == "mod" {
                    i += 3
                } else { return v }
                sawWork = true
                guard let r = unary() else { return nil }
                switch c {
                case "*", "×", "·": v *= r
                case "/", "÷": guard r != 0 else { return nil }; v /= r
                default: guard r != 0 else { return nil }; v = v.truncatingRemainder(dividingBy: r)
                }
            }
        }

        private mutating func unary() -> Double? {
            if let c = peek(), c == "-" || c == "+" || c == "−" {
                i += 1
                guard let v = unary() else { return nil }
                return c == "+" ? v : -v
            }
            return power()
        }

        private mutating func power() -> Double? {
            guard let base = postfix() else { return nil }
            if peek() == "^" {
                i += 1
                sawWork = true
                guard let e = unary() else { return nil }
                return Foundation.pow(base, e)
            }
            if peek() == "*", i + 1 < chars.count, chars[i + 1] == "*" {
                i += 2
                sawWork = true
                guard let e = unary() else { return nil }
                return Foundation.pow(base, e)
            }
            return base
        }

        private mutating func postfix() -> Double? {
            guard var v = primary() else { return nil }
            while peek() == "%" {
                i += 1
                sawWork = true
                v /= 100
            }
            // Implicit multiplication: `2pi`, `2(3+4)`, `(1+2)(3+4)`.
            if let c = peek(), c == "(" || (c.isLetter && Self.constants[word(at: i) ?? ""] != nil) {
                sawWork = true
                guard let r = postfix() else { return nil }
                v *= r
            }
            return v
        }

        private mutating func primary() -> Double? {
            guard let c = peek() else { return nil }
            if c == "(" {
                i += 1
                guard let v = expr(), peek() == ")" else { return nil }
                i += 1
                return v
            }
            if c.isNumber || c == "." { return number() }
            guard let w = word(at: i) else { return nil }
            if let k = Self.constants[w] {
                i += w.count
                return k
            }
            if let f = Self.functions[w] {
                i += w.count
                guard peek() == "(" else { return nil }
                i += 1
                guard let v = expr(), peek() == ")" else { return nil }
                i += 1
                sawWork = true
                return f(v)
            }
            return nil
        }

        /// Digits with one decimal point; `1,000` groups when every group after a comma has three
        /// digits. Underscores are allowed as in `1_000`.
        private mutating func number() -> Double? {
            var s = ""
            var dot = false
            while i < chars.count {
                let c = chars[i]
                if c.isASCII, c.isNumber { s.append(c); i += 1 }
                else if c == ".", !dot { dot = true; s.append(c); i += 1 }
                else if c == "_", !s.isEmpty { i += 1 }
                else if c == ",", !dot, !s.isEmpty, isGroup(at: i + 1) { i += 1 }
                else { break }
            }
            guard s != "." else { return nil }
            return Double(s)
        }

        /// Three ASCII digits at `at`, then no fourth.
        private func isGroup(at j: Int) -> Bool {
            guard j + 3 <= chars.count else { return false }
            for k in j..<(j + 3) where !(chars[k].isASCII && chars[k].isNumber) { return false }
            return j + 3 == chars.count || !(chars[j + 3].isASCII && chars[j + 3].isNumber)
        }

        /// The run of letters (and digits after the first letter) starting at `at`, lowercased.
        private func word(at j: Int) -> String? {
            guard j < chars.count, chars[j].isLetter else { return nil }
            var k = j
            while k < chars.count, chars[k].isLetter || (k > j && chars[k].isNumber) { k += 1 }
            return String(chars[j..<k]).lowercased()
        }
    }
}

/// Unit conversions: `<number or sum> <unit> in|to|as|= <unit>`, within one kind of quantity.
public enum Units {
    struct Unit {
        let symbol: String
        let kind: String
        /// Value in the kind's base unit = value * factor, except temperature (`toBase`).
        let factor: Double
    }

    /// Every unit by each name it answers to, lowercased.
    static let byName: [String: Unit] = {
        var map: [String: Unit] = [:]
        func add(_ kind: String, _ symbol: String, _ factor: Double, _ names: [String]) {
            let u = Unit(symbol: symbol, kind: kind, factor: factor)
            for n in [symbol.lowercased()] + names { map[n] = u }
        }
        // Length, in meters.
        add("length", "mm", 0.001, ["millimeter", "millimeters", "millimetre", "millimetres"])
        add("length", "cm", 0.01, ["centimeter", "centimeters", "centimetre", "centimetres"])
        add("length", "m", 1, ["meter", "meters", "metre", "metres"])
        add("length", "km", 1000, ["kilometer", "kilometers", "kilometre", "kilometres"])
        add("length", "in", 0.0254, ["inch", "inches", "\""])
        add("length", "ft", 0.3048, ["foot", "feet", "'"])
        add("length", "yd", 0.9144, ["yard", "yards"])
        add("length", "mi", 1609.344, ["mile", "miles"])
        add("length", "nmi", 1852, ["nautical mile", "nautical miles"])
        // Mass, in kilograms.
        add("mass", "mg", 1e-6, ["milligram", "milligrams"])
        add("mass", "g", 0.001, ["gram", "grams"])
        add("mass", "kg", 1, ["kilogram", "kilograms", "kilo", "kilos"])
        add("mass", "t", 1000, ["tonne", "tonnes", "metric ton", "metric tons"])
        add("mass", "oz", 0.028349523125, ["ounce", "ounces"])
        add("mass", "lb", 0.45359237, ["lbs", "pound", "pounds"])
        add("mass", "st", 6.35029318, ["stone", "stones"])
        // Volume, in liters (US customary).
        add("volume", "ml", 0.001, ["milliliter", "milliliters", "millilitre", "millilitres"])
        add("volume", "cl", 0.01, ["centiliter", "centiliters"])
        add("volume", "dl", 0.1, ["deciliter", "deciliters"])
        add("volume", "l", 1, ["liter", "liters", "litre", "litres"])
        add("volume", "tsp", 0.00492892159375, ["teaspoon", "teaspoons"])
        add("volume", "tbsp", 0.01478676478125, ["tablespoon", "tablespoons"])
        add("volume", "fl oz", 0.0295735295625, ["floz", "fluid ounce", "fluid ounces"])
        add("volume", "cup", 0.2365882365, ["cups"])
        add("volume", "pt", 0.473176473, ["pint", "pints"])
        add("volume", "qt", 0.946352946, ["quart", "quarts"])
        add("volume", "gal", 3.785411784, ["gallon", "gallons"])
        // Temperature: the factor is unused; see `toBase`.
        add("temperature", "°C", 1, ["c", "celsius", "°c", "degc"])
        add("temperature", "°F", 1, ["f", "fahrenheit", "°f", "degf"])
        add("temperature", "K", 1, ["k", "kelvin", "kelvins"])
        // Time, in seconds.
        add("time", "ms", 0.001, ["millisecond", "milliseconds"])
        add("time", "s", 1, ["sec", "secs", "second", "seconds"])
        add("time", "min", 60, ["mins", "minute", "minutes"])
        add("time", "h", 3600, ["hr", "hrs", "hour", "hours"])
        add("time", "d", 86400, ["day", "days"])
        add("time", "wk", 604800, ["week", "weeks"])
        add("time", "yr", 31_557_600, ["year", "years"])
        // Data, in bytes. Letters are folded, so "MB" and "mb" are both megabytes.
        add("data", "bit", 0.125, ["bits"])
        add("data", "B", 1, ["byte", "bytes"])
        add("data", "KB", 1e3, ["kilobyte", "kilobytes"])
        add("data", "MB", 1e6, ["megabyte", "megabytes"])
        add("data", "GB", 1e9, ["gigabyte", "gigabytes"])
        add("data", "TB", 1e12, ["terabyte", "terabytes"])
        add("data", "KiB", 1024, ["kibibyte", "kibibytes"])
        add("data", "MiB", 1_048_576, ["mebibyte", "mebibytes"])
        add("data", "GiB", 1_073_741_824, ["gibibyte", "gibibytes"])
        add("data", "TiB", 1_099_511_627_776, ["tebibyte", "tebibytes"])
        // Speed, in meters per second.
        add("speed", "m/s", 1, ["mps"])
        add("speed", "km/h", 1 / 3.6, ["kph", "kmh"])
        add("speed", "mph", 0.44704, ["mi/h"])
        add("speed", "kn", 0.514444444444, ["knot", "knots", "kt"])
        add("speed", "ft/s", 0.3048, ["fps"])
        // Area, in square meters.
        add("area", "m²", 1, ["m2", "sqm", "square meter", "square meters"])
        add("area", "km²", 1e6, ["km2", "square kilometer", "square kilometers"])
        add("area", "ft²", 0.09290304, ["ft2", "sqft", "square foot", "square feet"])
        add("area", "acre", 4046.8564224, ["acres", "ac"])
        add("area", "ha", 10_000, ["hectare", "hectares"])
        add("area", "mi²", 2_589_988.110336, ["mi2", "square mile", "square miles"])
        return map
    }()

    /// The words between the amount and the target unit.
    private static let joins = [" in ", " to ", " as ", " = ", " -> ", " => ", " into "]

    public static func convert(_ text: String) -> Calculator.Answer? {
        let lower = text.lowercased()
        // The last join, so "5 in in cm" reads as five inches in centimeters.
        guard let join = joins.compactMap({ j in lower.range(of: j, options: .backwards).map { (j, $0) } })
            .max(by: { $0.1.lowerBound < $1.1.lowerBound }) else { return nil }
        let left = lower[..<join.1.lowerBound].trimmingCharacters(in: .whitespaces)
        let right = lower[join.1.upperBound...].trimmingCharacters(in: .whitespaces)
        guard let to = byName[right], let (amount, from) = splitAmount(left), from.kind == to.kind,
              let base = toBase(amount, from) else { return nil }
        let v = fromBase(base, to)
        guard v.isFinite else { return nil }
        return Calculator.Answer(value: v, unit: to.symbol)
    }

    /// "5 km" or "5km" or "2*3 ft": the longest known unit name at the end, and a number before it.
    static func splitAmount(_ left: String) -> (Double, Unit)? {
        let chars = Array(left)
        // Try every split point from the left, so the longest unit name wins ("fl oz" over "oz").
        for cut in 1..<max(chars.count, 1) {
            let unitName = String(chars[cut...]).trimmingCharacters(in: .whitespaces)
            guard let u = byName[unitName] else { continue }
            let amountText = String(chars[..<cut]).trimmingCharacters(in: .whitespaces)
            guard !amountText.isEmpty, let n = Calculator.number(amountText) else { continue }
            return (n, u)
        }
        return nil
    }

    static func toBase(_ v: Double, _ u: Unit) -> Double? {
        guard u.kind == "temperature" else { return v * u.factor }
        switch u.symbol {
        case "°C": return v + 273.15
        case "°F": return (v - 32) * 5 / 9 + 273.15
        default: return v
        }
    }

    static func fromBase(_ v: Double, _ u: Unit) -> Double {
        guard u.kind == "temperature" else { return v / u.factor }
        switch u.symbol {
        case "°C": return v - 273.15
        case "°F": return (v - 273.15) * 9 / 5 + 32
        default: return v
        }
    }
}

/// The calculator as a launcher provider: one row, at the top, that copies the answer on Return.
public final class CalculatorProvider: LauncherProvider {
    public let name = "calculator"
    public init() {}

    public func results(for query: String) -> [LauncherResult] {
        guard let a = Calculator.evaluate(query) else { return [] }
        let asked = query.trimmingCharacters(in: .whitespaces)
        return [LauncherResult(id: "calc", section: "Calculator", title: a.display,
                               subtitle: "\(asked) · Return copies \(a.copyText)", symbol: "equal.square",
                               badge: "Copy", placement: .top, action: .copy(a.copyText))]
    }
}
