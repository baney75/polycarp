import CryptoKit
import XCTest
@testable import BaneySpacesCore

/// With no Polycarp theme file, every theme and palette resolves to exactly what it did before the
/// Polycarp adapter existed. `golden` was generated from origin/main (before PolycarpTheme.swift):
/// one SHA-256 for each theme and palette, over the encoded Look, ThemeCenter's spec and every
/// surface's resolved style and panel look. A change to any value, in any theme, fails here.
final class NoPolycarpThemeTests: XCTestCase {
    /// Everything a surface can read for one look, as stable text (palette colors in role order).
    static func encoded(_ theme: ThemeID, palette name: String) -> String {
        let accent = AccentPreset.red.rgb
        let look = Look(theme: theme, palette: name, accent: accent)
        var out = "theme=\(theme.rawValue) title=\(theme.title) palette=\(look.palette.name) dark=\(look.palette.isDark) auto=\(look.isAuto)\n"
        out += "spec=\(String(reflecting: look.spec))\n"
        for role in Palette.roles { out += "\(role)=\(String(describing: look.palette.color(role)))\n" }
        ThemeCenter.use(theme)
        out += "center=\(ThemeCenter.id.rawValue) \(String(reflecting: ThemeCenter.spec))\n"
        ThemeCenter.use(.baneyspaces)
        let settings = AppearanceSettings()
        for s in Surface.allCases {
            out += "\(s.rawValue) \(String(reflecting: SurfaceStyle.make(s, theme: theme, spec: look.spec)))\n"
            out += "\(s.rawValue) \(String(reflecting: PanelLook.make(s, look: look, settings: settings, accent: accent)))\n"
        }
        for r in ["light", "dark", "workspace", "nothing"] { out += "color \(r)=\(String(describing: look.color(r)))\n" }
        return out
    }

    static func digest(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func current() -> [String: String] {
        var out: [String: String] = [
        "baneyspaces/auto": "0ec3020f84594bd4a166f35f61417797ff7580a7d76591028572d9d4dd1d6d16",
        "baneyspaces/catppuccin": "a5d089c41d586ee1524e8eaaa3311701f4e22bdc9ca53d8bb63e1e77bc1bbfc0",
        "baneyspaces/catppuccin-latte": "6a643a871aabc9546142d268647c98cbc71525849bc86b61393800d3077707d6",
        "baneyspaces/ethereal": "1a9f029b1bb900b0695bd97fa4ec48383596b748dadfce8063066de7a34f885d",
        "baneyspaces/everforest": "04941ee44f39543de9abd7ae9a58361580444a7436d764a6f276113d5a2bf5e0",
        "baneyspaces/flexoki-light": "e8abfbe5324971eb892d4c9647b35f2125f420ae5235c2290d1ca9304302dbb5",
        "baneyspaces/gruvbox": "f75a0ef682e29a72575bae26dac7cf9fd14acc71151e1fb369c23d21b02e5fe9",
        "baneyspaces/hackerman": "193960a1c4dbab4fa45bab74a9200db00ab24c9dd9cdc53c18b4481a7c1bdda0",
        "baneyspaces/kanagawa": "7ec60b9350ec2f2e2f90a71b1e3637742882a2c119c6b8c9aa19a665131855c4",
        "baneyspaces/last-horizon": "8093b94e5e018c5d390269e94a9b93f414b12080b12535846d175e4b22bd7981",
        "baneyspaces/lumon": "265ff8c0b20f395af3386369f0b673111bfe6318989608089c3f17c694f7cab9",
        "baneyspaces/lupine": "50bab645efebbb9d4d4c0a2e12ee0b73af5398ddd42a27a97462c08cc4aacc98",
        "baneyspaces/matte-black": "64fc1a5a3e7f6e1c4bd709d342ee0d4ddec66ae10c321c1654942c5aadab4f5d",
        "baneyspaces/miasma": "3c4e63d3677c546d92c115fb99c2e7769b900b2de48156f40bef3dac88683c83",
        "baneyspaces/nord": "640d06c2bda840268d2e2133e8609b84afded0d68962120b1f369c7504113003",
        "baneyspaces/osaka-jade": "d6b3852d97c49626adb9e9e855d0f011600f6d02db2b45ec8d635a5f0d1d4c82",
        "baneyspaces/retro-82": "bce3b24a9461e87c9ecbd2236a666bc064c0b2d88ce800f3931b8bb66746ef9a",
        "baneyspaces/ristretto": "d055bd50c17c9b29659bec9a365db92a914a591b29c2d8999e41f7e9f070ac6a",
        "baneyspaces/rose-pine": "2029aec27138e42a6a0acd5af809c6988b444997ced1263aef17e7b038e4e955",
        "baneyspaces/solitude": "fa1a72dbdeaa305086fb07c5b07d6da9906dea48c22c486b7f8b88bcb432de30",
        "baneyspaces/tokyo-night": "a5d1e8623ee1d938905fec443cd2f7d02b4d687e42514355914b6208f7cb47ad",
        "baneyspaces/vantablack": "73524701913f28c353e8124a9495d586980dd526f22898664b09f60585cf87a4",
        "baneyspaces/white": "b02443e23c80e0d7e022b664be3720f411b61cea8a6cfcbe84d33a2916ed38b2",
        "minimal/auto": "ae5ed3c0004b57f0d4c60cf16d93c7d68aa575b7e1c6a3905d899f2236fc4abd",
        "minimal/catppuccin": "eebfee268c916478666c16ae3fd1caef57db0fb24305f0f7c9a64e58dca3daf2",
        "minimal/catppuccin-latte": "5267804862e978900fd2125725676f503eed08ebad80b3bf15330dff82f4815b",
        "minimal/ethereal": "edac28d299c022f6b985b16833cbeddd8649323844dfd88a0f6b443aab37627e",
        "minimal/everforest": "68964e29d8b5fa8b1b6c623122b592b498bbdda367d202b16fc2215eecbff544",
        "minimal/flexoki-light": "81fb2369df5d493028103d7d7ac8db388b9d7e0875ec4674b71c09501538321a",
        "minimal/gruvbox": "8d4d6160727e19c2d92eaa9ed36e91a2d6337f0e381830bd042d426835769ac2",
        "minimal/hackerman": "08855dc19eaab1a027538cac17fd435e296dd2fe0f860d0038f3ff44f5406590",
        "minimal/kanagawa": "1f45882418daa64a2fb70519a2da5d739559333f02453a30957eeab35f5e27fd",
        "minimal/last-horizon": "992364ef98b094a40f24e8f612a7e54c2376a3992e6d506edf44de53d658043b",
        "minimal/lumon": "c8c5a2d3c1860bbdc1a794a8d8793884bd5cb4852e269d88330672a9cfe54a36",
        "minimal/lupine": "40fc8d094fbe312ff7088e06a6aa21581edf5cc1eb461fe70021bdeb0a38e810",
        "minimal/matte-black": "faa16fbe6da56b076f34cb689804e6736e168349e61c7982392a36a9066c0cf8",
        "minimal/miasma": "ad695a52eb9f6966834399a099c42e2c5ebfd0576d64ab1ababa0ad74aed4066",
        "minimal/nord": "d2fb214d463b0aca40df8b98d4ccf833bb327a0f6e155404588cd90cb4613627",
        "minimal/osaka-jade": "615be6368f71b994beb54d3fd11da4b12db61d161d797be8ba87c0b5b6c7e07c",
        "minimal/retro-82": "5713c339e97cbc7c4e8fa773c29d91f5d8421878ad91dd484122c447ccdc4db8",
        "minimal/ristretto": "681a9386a37cc26fe96544216ad6741ae87abe990bf9e7a7eed66b0a9a649b91",
        "minimal/rose-pine": "789025a4c9bd56b4fb7026744e966de8b36f2005688f698b6af78b83e75c9f14",
        "minimal/solitude": "28859d5abceca0a83a844331d9c0e990b762f8fc0a1efef598122390a9794734",
        "minimal/tokyo-night": "ad22ba1708eb9487ba387a8e584331f61eedf2140fc56fecde9f7e60cca28caa",
        "minimal/vantablack": "e0119ace82759034d0d2331b48db368552f8feda0c252ed43da5421d806b0996",
        "minimal/white": "99fd95840d7f41e515ec66f7a6b65c20fa8f6e1e67fddebadddf876f2e879031",
        "omarchy/auto": "b86f4319986fedbc955a3c129552bb2497f970c5d0a1ba78a1a91f887f4124c6",
        "omarchy/catppuccin": "d5e45a85c1a357cb17df845350cf481c4fb43aa621c457638cd4e1dfbad233c5",
        "omarchy/catppuccin-latte": "0e8cf9eac9b438b3485dbe2c34913d2245a9a6c0917a9c05e8234fff07f32906",
        "omarchy/ethereal": "5257e17db99eea05c911be8331c5475128310e82ddc08a61f79723d771125638",
        "omarchy/everforest": "89778ded5a32afeec6be30ca4f39a9f7bd23c18eb43f40304283eb33e4466c9b",
        "omarchy/flexoki-light": "4bbb32bd6d3d83033fc34a2f1b06f230fd6e95a9e801a678cd858d52c9d5f112",
        "omarchy/gruvbox": "1cd62f6b54591dec0d5bf758566cbea37561b615fc23c25426d16160ace63601",
        "omarchy/hackerman": "eecb276ddc11c3948bd7c611adc1f9a7631a380fc2aa3189c105eaad81167819",
        "omarchy/kanagawa": "9e412703daf7f13f8a7372dd0f57ad74ed0af5c99669d84bce467fa5d348a364",
        "omarchy/last-horizon": "3a7aebc63d6fce84229b14452a8ccfc4801c8cfc4747f2ad20b6460550c80f64",
        "omarchy/lumon": "d7936054e51bebb9ab759c805eaf3b1b0e6f5b844e45c79321587f0e3bfc918d",
        "omarchy/lupine": "f3529c8f58994aba5a119f082b57ff4ab2f4eef402c5ded9cfc3aee812805a21",
        "omarchy/matte-black": "802bf8904303f45af27a77a298a606d7c6287848a48ac66606fb55d89206ea35",
        "omarchy/miasma": "f0f8f516928b4cc2c6313c5a052d9e4442c70fb04d8e65785df237e5acf8929e",
        "omarchy/nord": "a252122ad5364dff147a8cd09741ce256ad5c525d8fff18c544c25c686900537",
        "omarchy/osaka-jade": "f2653076d9ea5dd1b21ccc9ef48da3a747514bf2e485f4f21c53a152f8b98965",
        "omarchy/retro-82": "60d76789f0dd6b76272b0ae3fa4319fb00f5bbaacf9191b558208a03c8b79f5c",
        "omarchy/ristretto": "03d5efa76de25c0310c8d85d699e69c1f83d57de89cfa2060178e1a275f5d5b3",
        "omarchy/rose-pine": "2d53704a0b5c29609620492010bbf41d63337cb8a1ceeeccc6310e45c20efbbf",
        "omarchy/solitude": "24f5d778bbddffa3925b424947529798f2aeafb650a1392cf9323fb5d5f28f03",
        "omarchy/tokyo-night": "564bc2d0917fa5fc48f408ffcfb6795bb1f1e980b49985c587b9b267327d2835",
        "omarchy/vantablack": "c72498ae8ae5ce946c35a88f029491e2661129c3833eb87ab3f470e330dce94e",
        "omarchy/white": "a5350d425756e857499df58c11a1231802f863a78079bb559b3c6291317cc650",
    ]
        for t in ThemeID.allCases {
            for p in ["auto"] + PaletteCatalog.shared.names { out["\(t.rawValue)/\(p)"] = digest(encoded(t, palette: p)) }
        }
        return out
    }

    func testEveryThemeAndPaletteResolvesAsItDidOnMain() {
        let now = Self.current()
        if ProcessInfo.processInfo.environment["PRINT_GOLDEN"] != nil {
            for k in now.keys.sorted() { print("GOLDEN \"\(k)\": \"\(now[k]!)\",") }
        }
        XCTAssertEqual(now.count, ThemeID.allCases.count * (PaletteCatalog.shared.names.count + 1))
        XCTAssertEqual(Set(now.keys), Set(Self.golden.keys), "a theme or palette was added or removed")
        for k in now.keys.sorted() where Self.golden[k] != nil {
            XCTAssertEqual(now[k], Self.golden[k], "\(k) no longer resolves as it did on origin/main")
        }
    }

    static let golden: [String: String] = [
        "baneyspaces/auto": "0ec3020f84594bd4a166f35f61417797ff7580a7d76591028572d9d4dd1d6d16",
        "baneyspaces/catppuccin": "a5d089c41d586ee1524e8eaaa3311701f4e22bdc9ca53d8bb63e1e77bc1bbfc0",
        "baneyspaces/catppuccin-latte": "6a643a871aabc9546142d268647c98cbc71525849bc86b61393800d3077707d6",
        "baneyspaces/ethereal": "1a9f029b1bb900b0695bd97fa4ec48383596b748dadfce8063066de7a34f885d",
        "baneyspaces/everforest": "04941ee44f39543de9abd7ae9a58361580444a7436d764a6f276113d5a2bf5e0",
        "baneyspaces/flexoki-light": "e8abfbe5324971eb892d4c9647b35f2125f420ae5235c2290d1ca9304302dbb5",
        "baneyspaces/gruvbox": "f75a0ef682e29a72575bae26dac7cf9fd14acc71151e1fb369c23d21b02e5fe9",
        "baneyspaces/hackerman": "193960a1c4dbab4fa45bab74a9200db00ab24c9dd9cdc53c18b4481a7c1bdda0",
        "baneyspaces/kanagawa": "7ec60b9350ec2f2e2f90a71b1e3637742882a2c119c6b8c9aa19a665131855c4",
        "baneyspaces/last-horizon": "8093b94e5e018c5d390269e94a9b93f414b12080b12535846d175e4b22bd7981",
        "baneyspaces/lumon": "265ff8c0b20f395af3386369f0b673111bfe6318989608089c3f17c694f7cab9",
        "baneyspaces/lupine": "50bab645efebbb9d4d4c0a2e12ee0b73af5398ddd42a27a97462c08cc4aacc98",
        "baneyspaces/matte-black": "64fc1a5a3e7f6e1c4bd709d342ee0d4ddec66ae10c321c1654942c5aadab4f5d",
        "baneyspaces/miasma": "3c4e63d3677c546d92c115fb99c2e7769b900b2de48156f40bef3dac88683c83",
        "baneyspaces/nord": "640d06c2bda840268d2e2133e8609b84afded0d68962120b1f369c7504113003",
        "baneyspaces/osaka-jade": "d6b3852d97c49626adb9e9e855d0f011600f6d02db2b45ec8d635a5f0d1d4c82",
        "baneyspaces/retro-82": "bce3b24a9461e87c9ecbd2236a666bc064c0b2d88ce800f3931b8bb66746ef9a",
        "baneyspaces/ristretto": "d055bd50c17c9b29659bec9a365db92a914a591b29c2d8999e41f7e9f070ac6a",
        "baneyspaces/rose-pine": "2029aec27138e42a6a0acd5af809c6988b444997ced1263aef17e7b038e4e955",
        "baneyspaces/solitude": "fa1a72dbdeaa305086fb07c5b07d6da9906dea48c22c486b7f8b88bcb432de30",
        "baneyspaces/tokyo-night": "a5d1e8623ee1d938905fec443cd2f7d02b4d687e42514355914b6208f7cb47ad",
        "baneyspaces/vantablack": "73524701913f28c353e8124a9495d586980dd526f22898664b09f60585cf87a4",
        "baneyspaces/white": "b02443e23c80e0d7e022b664be3720f411b61cea8a6cfcbe84d33a2916ed38b2",
        "minimal/auto": "ae5ed3c0004b57f0d4c60cf16d93c7d68aa575b7e1c6a3905d899f2236fc4abd",
        "minimal/catppuccin": "eebfee268c916478666c16ae3fd1caef57db0fb24305f0f7c9a64e58dca3daf2",
        "minimal/catppuccin-latte": "5267804862e978900fd2125725676f503eed08ebad80b3bf15330dff82f4815b",
        "minimal/ethereal": "edac28d299c022f6b985b16833cbeddd8649323844dfd88a0f6b443aab37627e",
        "minimal/everforest": "68964e29d8b5fa8b1b6c623122b592b498bbdda367d202b16fc2215eecbff544",
        "minimal/flexoki-light": "81fb2369df5d493028103d7d7ac8db388b9d7e0875ec4674b71c09501538321a",
        "minimal/gruvbox": "8d4d6160727e19c2d92eaa9ed36e91a2d6337f0e381830bd042d426835769ac2",
        "minimal/hackerman": "08855dc19eaab1a027538cac17fd435e296dd2fe0f860d0038f3ff44f5406590",
        "minimal/kanagawa": "1f45882418daa64a2fb70519a2da5d739559333f02453a30957eeab35f5e27fd",
        "minimal/last-horizon": "992364ef98b094a40f24e8f612a7e54c2376a3992e6d506edf44de53d658043b",
        "minimal/lumon": "c8c5a2d3c1860bbdc1a794a8d8793884bd5cb4852e269d88330672a9cfe54a36",
        "minimal/lupine": "40fc8d094fbe312ff7088e06a6aa21581edf5cc1eb461fe70021bdeb0a38e810",
        "minimal/matte-black": "faa16fbe6da56b076f34cb689804e6736e168349e61c7982392a36a9066c0cf8",
        "minimal/miasma": "ad695a52eb9f6966834399a099c42e2c5ebfd0576d64ab1ababa0ad74aed4066",
        "minimal/nord": "d2fb214d463b0aca40df8b98d4ccf833bb327a0f6e155404588cd90cb4613627",
        "minimal/osaka-jade": "615be6368f71b994beb54d3fd11da4b12db61d161d797be8ba87c0b5b6c7e07c",
        "minimal/retro-82": "5713c339e97cbc7c4e8fa773c29d91f5d8421878ad91dd484122c447ccdc4db8",
        "minimal/ristretto": "681a9386a37cc26fe96544216ad6741ae87abe990bf9e7a7eed66b0a9a649b91",
        "minimal/rose-pine": "789025a4c9bd56b4fb7026744e966de8b36f2005688f698b6af78b83e75c9f14",
        "minimal/solitude": "28859d5abceca0a83a844331d9c0e990b762f8fc0a1efef598122390a9794734",
        "minimal/tokyo-night": "ad22ba1708eb9487ba387a8e584331f61eedf2140fc56fecde9f7e60cca28caa",
        "minimal/vantablack": "e0119ace82759034d0d2331b48db368552f8feda0c252ed43da5421d806b0996",
        "minimal/white": "99fd95840d7f41e515ec66f7a6b65c20fa8f6e1e67fddebadddf876f2e879031",
        "omarchy/auto": "b86f4319986fedbc955a3c129552bb2497f970c5d0a1ba78a1a91f887f4124c6",
        "omarchy/catppuccin": "d5e45a85c1a357cb17df845350cf481c4fb43aa621c457638cd4e1dfbad233c5",
        "omarchy/catppuccin-latte": "0e8cf9eac9b438b3485dbe2c34913d2245a9a6c0917a9c05e8234fff07f32906",
        "omarchy/ethereal": "5257e17db99eea05c911be8331c5475128310e82ddc08a61f79723d771125638",
        "omarchy/everforest": "89778ded5a32afeec6be30ca4f39a9f7bd23c18eb43f40304283eb33e4466c9b",
        "omarchy/flexoki-light": "4bbb32bd6d3d83033fc34a2f1b06f230fd6e95a9e801a678cd858d52c9d5f112",
        "omarchy/gruvbox": "1cd62f6b54591dec0d5bf758566cbea37561b615fc23c25426d16160ace63601",
        "omarchy/hackerman": "eecb276ddc11c3948bd7c611adc1f9a7631a380fc2aa3189c105eaad81167819",
        "omarchy/kanagawa": "9e412703daf7f13f8a7372dd0f57ad74ed0af5c99669d84bce467fa5d348a364",
        "omarchy/last-horizon": "3a7aebc63d6fce84229b14452a8ccfc4801c8cfc4747f2ad20b6460550c80f64",
        "omarchy/lumon": "d7936054e51bebb9ab759c805eaf3b1b0e6f5b844e45c79321587f0e3bfc918d",
        "omarchy/lupine": "f3529c8f58994aba5a119f082b57ff4ab2f4eef402c5ded9cfc3aee812805a21",
        "omarchy/matte-black": "802bf8904303f45af27a77a298a606d7c6287848a48ac66606fb55d89206ea35",
        "omarchy/miasma": "f0f8f516928b4cc2c6313c5a052d9e4442c70fb04d8e65785df237e5acf8929e",
        "omarchy/nord": "a252122ad5364dff147a8cd09741ce256ad5c525d8fff18c544c25c686900537",
        "omarchy/osaka-jade": "f2653076d9ea5dd1b21ccc9ef48da3a747514bf2e485f4f21c53a152f8b98965",
        "omarchy/retro-82": "60d76789f0dd6b76272b0ae3fa4319fb00f5bbaacf9191b558208a03c8b79f5c",
        "omarchy/ristretto": "03d5efa76de25c0310c8d85d699e69c1f83d57de89cfa2060178e1a275f5d5b3",
        "omarchy/rose-pine": "2d53704a0b5c29609620492010bbf41d63337cb8a1ceeeccc6310e45c20efbbf",
        "omarchy/solitude": "24f5d778bbddffa3925b424947529798f2aeafb650a1392cf9323fb5d5f28f03",
        "omarchy/tokyo-night": "564bc2d0917fa5fc48f408ffcfb6795bb1f1e980b49985c587b9b267327d2835",
        "omarchy/vantablack": "c72498ae8ae5ce946c35a88f029491e2661129c3833eb87ab3f470e330dce94e",
        "omarchy/white": "a5350d425756e857499df58c11a1231802f863a78079bb559b3c6291317cc650",
    ]
}

/// The golden hashes above cover `Look`, `ThemeSpec` and `SurfaceStyle`. The font a surface falls back to
/// when a theme's family isn't installed is decided in the app target (`Chrome`), so no hash could see
/// it change: the proportional fallback for catalog keys slipped through. The decision is `FontFallback`
/// now, and these hold it.
extension NoPolycarpThemeTests {
    func testEveryCatalogFontKeyKeepsTheMonospacedFallbackAndOnlyThePolycarpKeyIsProportional() {
        let cat = ThemeCatalog.shared
        var keys = Set(ThemeID.allCases.map { cat.spec($0).font.family })
        keys.formUnion(["monospace", "jetbrains-mono", "nerd-mono", "some future key"])
        // AppKit reaches the fallback for system-sans (`face` returns nil for it), and it has always been the system font.
        XCTAssertNotNil(keys.remove("system-sans"), "the catalog stopped using system-sans; this pin no longer proves anything")
        XCTAssertEqual(FontFallback.forFamily("system-sans"), .proportional)
        for key in keys { XCTAssertEqual(FontFallback.forFamily(key), .monospaced, key) }
        XCTAssertEqual(FontFallback.forFamily(PolycarpTheme.fontKey), .proportional)
    }

    func testBothDrawingPathsAskFontFallbackAndNeitherHardCodesAFamily() throws {
        let code = try Repo.code("Sources/BaneySpaces/Theming.swift")
        XCTAssertEqual(code.components(separatedBy: "FontFallback.forFamily(f.family)").count - 1, 2, "AppKit and SwiftUI")
        XCTAssertFalse(code.contains("f.family == \"monospace\""))
    }
}
