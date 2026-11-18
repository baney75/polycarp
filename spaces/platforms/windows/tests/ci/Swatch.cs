// The windows switch-bench.ps1 switches between: one solid-color window per argument ("R,G,B"), titled "swatch NN",
// laid out on a six-column grid over the primary display's work area with none overlapping. A process of its own, so
// the daemon manages its windows as it would any app's. Built by switch-bench.ps1 with Add-Type -OutputAssembly.
using System;
using System.Drawing;
using System.Windows.Forms;

static class Swatch {
    [STAThread]
    static void Main(string[] args) {
        var area = Screen.PrimaryScreen.WorkingArea;
        int cols = 6, rows = (args.Length + cols - 1) / cols;
        int w = area.Width / cols, h = area.Height / rows;
        for (int i = 0; i < args.Length; i++) {
            var c = args[i].Split(',');
            var f = new Form {
                Text = String.Format("swatch {0:D2}", i + 1),
                BackColor = Color.FromArgb(int.Parse(c[0]), int.Parse(c[1]), int.Parse(c[2])),
                StartPosition = FormStartPosition.Manual,
                FormBorderStyle = FormBorderStyle.FixedSingle,
                MaximizeBox = false,
                ShowIcon = false,
                Bounds = new Rectangle(area.X + (i % cols) * w + 3, area.Y + (i / cols) * h + 3, w - 6, h - 6),
            };
            f.Show();
        }
        Application.Run();
    }
}
