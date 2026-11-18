/// What the session socket refuses whoever sends it. The socket is open to every process of this user, so a step only
/// Donovan may take is refused here, before it reaches the app.
public enum SocketPolicy {
    public static func refusal(for r: Wire.Request) -> String? {
        if r.op == .sandbox, r.text?.lowercased() == "images" {
            return "deleting the sandbox's images (24 GB to download again) is Donovan's to do: Settings > Agents > Delete Images"
        }
        return nil
    }
}
