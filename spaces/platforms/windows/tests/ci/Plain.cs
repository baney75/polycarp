// drag.ps1's Win32 window: a sizable WinForms form, which is a classic HWND with the system's own frame, titled
// "drag plain". Built by drag.ps1 with Add-Type -OutputAssembly.
using System;
using System.Drawing;
using System.Windows.Forms;

static class Plain {
    [STAThread]
    static void Main() {
        var f = new Form { Text = "drag plain", BackColor = Color.FromArgb(41, 199, 61), StartPosition = FormStartPosition.Manual, Bounds = new Rectangle(250, 160, 520, 400) };
        Application.Run(f);
    }
}
