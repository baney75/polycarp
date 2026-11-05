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
        "baneyspaces/auto": "00ee94332eb7134cadf079dd5c7828f247953b42058728dec971ac6bb68e0292",
        "baneyspaces/catppuccin": "27cf20cd856b1d7d19059c5ff369b3e34cf00b7626c57c276bead96ba0fd3978",
        "baneyspaces/catppuccin-latte": "d466f1cd7bd7f2b1ad92088aec1553ca1b546b0eb40902a30b5a3d23ca208efd",
        "baneyspaces/ethereal": "5548620af42074ec52825d07ac3146ee1d7336e2df244a24ec5f04bc4055e078",
        "baneyspaces/everforest": "f318be169e0c870f7620ecdbe0eaa682274371c317107b7b43c86a306d1fc310",
        "baneyspaces/flexoki-light": "5da383665a1dc7a8ec9aef086c9b864703c816421eef52e23e33cff9be9fb3cc",
        "baneyspaces/gruvbox": "04eae7d91f8d689004a4d648e02e7d2c07365c37cae334aba1caf5071fcc82cf",
        "baneyspaces/hackerman": "19e11c82e004a57956c6e3e7cdb1db9b4efefef9aa6bdb0ef168aee30d7304e5",
        "baneyspaces/kanagawa": "21a9308029aa06339b5e02037c562175687a19d08fafdc10c7d7cd536016f5b1",
        "baneyspaces/last-horizon": "a2c318c97d5af26094b084ff4cb1a6d7a10316dcfd6eacc652037eaa51267bc3",
        "baneyspaces/lumon": "8f2a61aa885f08a97f1f063ef641cc3b7545e8329542c42215c41c79bac7113c",
        "baneyspaces/lupine": "5f29c373f2495a7fc7ca6e3888d4791c86038ece2f65c958e7257caefdb90fa7",
        "baneyspaces/matte-black": "d9f7c5952ce20d4ed9ba05245d802cea4d0f0f3fbb72a27bff5b2e9ad79ef1de",
        "baneyspaces/miasma": "68f2a980593f494f72559f1de4a6d607587a60205b05c67e0dfc20a3b6a51733",
        "baneyspaces/nord": "959f163dd9c67b3609f3897e98a5f0b103f1704221bf75a79724c6c1001673b2",
        "baneyspaces/osaka-jade": "9939f80abcc32a70a8918e65bb62ea94a98c05df6d99c19c8f8d9744bb6e67ec",
        "baneyspaces/retro-82": "2a9f508bf17c6eb20746af97b518fa28cf4e6ccf842f736d98b3f686740234f8",
        "baneyspaces/ristretto": "8ef1ae590991150cf046b65d01d92bc6814921a7c17795621d0478db978b3905",
        "baneyspaces/rose-pine": "f853eeba9cc45898a63252534bc8f1ee2aa95de22d7c276f1a9dfe34d36759a7",
        "baneyspaces/solitude": "197993e9e23d7d8753a4dcbefe5ac1893db7c5cf7f2f022384c92dcb62bcd73a",
        "baneyspaces/tokyo-night": "e163cc648bdbd11b5d658f0b4554209f693865bf49de02b3d5db9a9e8e4a9ac4",
        "baneyspaces/vantablack": "0f448fed737526b5afceb847a3bcebcc1d2a0812ca2de68714c409cde13e815c",
        "baneyspaces/white": "cae36d604ee2188400daf6cff065bc46d0debaec422af72c84ae5ce184502fe8",
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
        "baneyspaces/auto": "00ee94332eb7134cadf079dd5c7828f247953b42058728dec971ac6bb68e0292",
        "baneyspaces/catppuccin": "27cf20cd856b1d7d19059c5ff369b3e34cf00b7626c57c276bead96ba0fd3978",
        "baneyspaces/catppuccin-latte": "d466f1cd7bd7f2b1ad92088aec1553ca1b546b0eb40902a30b5a3d23ca208efd",
        "baneyspaces/ethereal": "5548620af42074ec52825d07ac3146ee1d7336e2df244a24ec5f04bc4055e078",
        "baneyspaces/everforest": "f318be169e0c870f7620ecdbe0eaa682274371c317107b7b43c86a306d1fc310",
        "baneyspaces/flexoki-light": "5da383665a1dc7a8ec9aef086c9b864703c816421eef52e23e33cff9be9fb3cc",
        "baneyspaces/gruvbox": "04eae7d91f8d689004a4d648e02e7d2c07365c37cae334aba1caf5071fcc82cf",
        "baneyspaces/hackerman": "19e11c82e004a57956c6e3e7cdb1db9b4efefef9aa6bdb0ef168aee30d7304e5",
        "baneyspaces/kanagawa": "21a9308029aa06339b5e02037c562175687a19d08fafdc10c7d7cd536016f5b1",
        "baneyspaces/last-horizon": "a2c318c97d5af26094b084ff4cb1a6d7a10316dcfd6eacc652037eaa51267bc3",
        "baneyspaces/lumon": "8f2a61aa885f08a97f1f063ef641cc3b7545e8329542c42215c41c79bac7113c",
        "baneyspaces/lupine": "5f29c373f2495a7fc7ca6e3888d4791c86038ece2f65c958e7257caefdb90fa7",
        "baneyspaces/matte-black": "d9f7c5952ce20d4ed9ba05245d802cea4d0f0f3fbb72a27bff5b2e9ad79ef1de",
        "baneyspaces/miasma": "68f2a980593f494f72559f1de4a6d607587a60205b05c67e0dfc20a3b6a51733",
        "baneyspaces/nord": "959f163dd9c67b3609f3897e98a5f0b103f1704221bf75a79724c6c1001673b2",
        "baneyspaces/osaka-jade": "9939f80abcc32a70a8918e65bb62ea94a98c05df6d99c19c8f8d9744bb6e67ec",
        "baneyspaces/retro-82": "2a9f508bf17c6eb20746af97b518fa28cf4e6ccf842f736d98b3f686740234f8",
        "baneyspaces/ristretto": "8ef1ae590991150cf046b65d01d92bc6814921a7c17795621d0478db978b3905",
        "baneyspaces/rose-pine": "f853eeba9cc45898a63252534bc8f1ee2aa95de22d7c276f1a9dfe34d36759a7",
        "baneyspaces/solitude": "197993e9e23d7d8753a4dcbefe5ac1893db7c5cf7f2f022384c92dcb62bcd73a",
        "baneyspaces/tokyo-night": "e163cc648bdbd11b5d658f0b4554209f693865bf49de02b3d5db9a9e8e4a9ac4",
        "baneyspaces/vantablack": "0f448fed737526b5afceb847a3bcebcc1d2a0812ca2de68714c409cde13e815c",
        "baneyspaces/white": "cae36d604ee2188400daf6cff065bc46d0debaec422af72c84ae5ce184502fe8",
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
