#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dxgi1_6.h>
#include <dwmapi.h>
#include <shlobj.h>
#include <wrl/client.h>
#include <iostream>
#include <string>
#include <vector>
#include <cstdint>
#include <cstdio>
#include <cstring>

static std::wstring quote(const wchar_t* value) {
    std::wstring result = L"\"";
    unsigned slashes = 0;
    for (const wchar_t* p = value; *p; ++p) {
        if (*p == L'\\') { ++slashes; continue; }
        if (*p == L'\"') result.append(slashes * 2 + 1, L'\\');
        else result.append(slashes, L'\\');
        slashes = 0;
        result += *p;
    }
    result.append(slashes * 2, L'\\');
    return result + L"\"";
}

// JSON string from UTF-16: window titles and adapter names carry arbitrary characters.
static std::string json(const wchar_t* value) {
    const int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
    std::string utf8(size > 1 ? size - 1 : 0, '\0');
    if (size > 1) WideCharToMultiByte(CP_UTF8, 0, value, -1, utf8.data(), size, nullptr, nullptr);
    std::string result = "\"";
    for (const unsigned char c : utf8) {
        if (c == '"' || c == '\\') { result += '\\'; result += static_cast<char>(c); }
        else if (c < 0x20) { char escaped[8]; snprintf(escaped, sizeof(escaped), "\\u%04x", c); result += escaped; }
        else result += static_cast<char>(c);
    }
    return result + "\"";
}

// The job owns FFmpeg. If Electron crashes, the parent process handle signals
// and closing the job stops capture instead of leaving an orphan filling disk.
static int runRecorder(int argc, wchar_t** argv) {
    if (argc < 5) return 10;
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, wcstoul(argv[2], nullptr, 10));
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!parent || !job) return 11;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 12;
    std::wstring command;
    for (int i = 3; i < argc; ++i) {
        if (i > 3) command += L' ';
        command += quote(argv[i]);
    }
    std::vector<wchar_t> buffer(command.begin(), command.end());
    buffer.push_back(0);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(argv[3], buffer.data(), nullptr, nullptr, TRUE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) return 13;
    if (!AssignProcessToJobObject(job, process.hProcess)) {
        TerminateProcess(process.hProcess, 14);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return 14;
    }
    ResumeThread(process.hThread);
    CloseHandle(process.hThread);
    HANDLE waits[] = { process.hProcess, parent };
    const DWORD completed = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
    DWORD code = 15;
    if (completed == WAIT_OBJECT_0) GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(job);
    CloseHandle(parent);
    CloseHandle(process.hProcess);
    return static_cast<int>(code);
}

// DWM's frame bounds exclude the invisible resize borders that GetWindowRect includes.
// Coordinates are physical pixels because the process is per-monitor DPI aware.
static bool windowBounds(HWND window, RECT& rect) {
    if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &rect, sizeof(rect)))) return true;
    return GetWindowRect(window, &rect) != FALSE;
}

static void printRect(const RECT& r) {
    std::cout << "\"x\":" << r.left << ",\"y\":" << r.top << ",\"width\":" << r.right - r.left
              << ",\"height\":" << r.bottom - r.top;
}

static int locateWindows(int argc, wchar_t** argv) {
    std::cout << "[";
    bool first = true;
    for (int i = 2; i < argc; ++i) {
        wchar_t* end = nullptr;
        const auto handle = wcstoull(argv[i], &end, 10);
        if (!handle || !end || *end) continue;
        const auto window = reinterpret_cast<HWND>(static_cast<uintptr_t>(handle));
        if (!IsWindow(window)) continue;
        MONITORINFOEXW monitor{};
        monitor.cbSize = sizeof(monitor);
        if (!GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor)) continue;
        RECT bounds{};
        if (!windowBounds(window, bounds)) continue;
        if (!first) std::cout << ",";
        first = false;
        std::cout << "{\"handle\":\"" << handle << "\",\"x\":" << monitor.rcMonitor.left
                  << ",\"y\":" << monitor.rcMonitor.top << ",\"minimized\":" << (IsIconic(window) ? "true" : "false")
                  << ",\"window\":{";
        printRect(bounds);
        std::cout << "}}";
    }
    std::cout << "]\n";
    return 0;
}

// Visible top-level windows in z-order, topmost first, for the region picker's snapping.
// Windows of excludePid are skipped: Electron's browser process owns every BrowserWindow.
struct WindowList { DWORD excludePid; bool first; };
static BOOL CALLBACK listWindow(HWND window, LPARAM param) {
    auto& list = *reinterpret_cast<WindowList*>(param);
    if (!IsWindowVisible(window) || IsIconic(window)) return TRUE;
    if (GetWindowLongW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) return TRUE;
    BOOL cloaked = FALSE;
    DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
    if (cloaked) return TRUE;
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    if (pid == list.excludePid) return TRUE;
    wchar_t title[256] = L"";
    GetWindowTextW(window, title, 256);
    if (!title[0]) return TRUE;
    RECT bounds{};
    if (!windowBounds(window, bounds) || bounds.right - bounds.left < 40 || bounds.bottom - bounds.top < 40) return TRUE;
    if (!list.first) std::cout << ",";
    list.first = false;
    std::cout << "{\"handle\":\"" << reinterpret_cast<uintptr_t>(window) << "\",\"title\":" << json(title) << ",";
    printRect(bounds);
    std::cout << "}";
    return TRUE;
}

// CF_HDROP plus a copy drop effect is what Explorer puts on the clipboard, so chat apps and
// file managers paste the file itself. SetClipboardData needs an owner window; the data
// stays on the clipboard after this process exits.
static int copyFiles(int argc, wchar_t** argv) {
    std::wstring paths;
    for (int i = 2; i < argc; ++i) {
        if (GetFileAttributesW(argv[i]) == INVALID_FILE_ATTRIBUTES) return 21;
        paths += argv[i];
        paths += L'\0';
    }
    if (paths.empty()) return 20;
    paths += L'\0';
    HWND owner = CreateWindowExW(0, L"STATIC", L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, nullptr, nullptr);
    if (!owner) return 22;
    const SIZE_T bytes = sizeof(DROPFILES) + paths.size() * sizeof(wchar_t);
    HGLOBAL drop = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes);
    HGLOBAL effect = GlobalAlloc(GMEM_MOVEABLE, sizeof(DWORD));
    int result = 23;
    if (drop && effect) {
        auto* files = static_cast<DROPFILES*>(GlobalLock(drop));
        files->pFiles = sizeof(DROPFILES);
        files->fWide = TRUE;
        memcpy(reinterpret_cast<char*>(files) + sizeof(DROPFILES), paths.data(), paths.size() * sizeof(wchar_t));
        GlobalUnlock(drop);
        *static_cast<DWORD*>(GlobalLock(effect)) = DROPEFFECT_COPY;
        GlobalUnlock(effect);
        if (OpenClipboard(owner)) {
            EmptyClipboard();
            if (SetClipboardData(CF_HDROP, drop)) {
                drop = nullptr;
                if (SetClipboardData(RegisterClipboardFormatW(L"Preferred DropEffect"), effect)) effect = nullptr;
                result = 0;
            }
            CloseClipboard();
        }
    }
    if (drop) GlobalFree(drop);
    if (effect) GlobalFree(effect);
    DestroyWindow(owner);
    return result;
}

// Enumerate the DXGI adapter/output pairs FFmpeg addresses: -init_hw_device d3d11va=<adapter>
// indexes the same EnumAdapters order, and ddagrab's output_idx counts that adapter's outputs.
// Electron's screen IDs and Windows' display numbers are not DXGI indices.
int wmain(int argc, wchar_t** argv) {
    if (argc > 1 && std::wstring(argv[1]) == L"--run") return runRecorder(argc, argv);
    if (argc > 1 && std::wstring(argv[1]) == L"--copy-files") return copyFiles(argc, argv);
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if (argc > 1 && std::wstring(argv[1]) == L"--windows") return locateWindows(argc, argv);
    if (argc > 1 && std::wstring(argv[1]) == L"--window-rects") {
        WindowList list{ argc > 2 ? wcstoul(argv[2], nullptr, 10) : 0, true };
        std::cout << "[";
        EnumWindows(listWindow, reinterpret_cast<LPARAM>(&list));
        std::cout << "]\n";
        return 0;
    }
    using Microsoft::WRL::ComPtr;
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return 1;
    std::cout << "[";
    bool first = true;
    for (UINT a = 0;; ++a) {
        ComPtr<IDXGIAdapter1> adapter;
        if (factory->EnumAdapters1(a, &adapter) == DXGI_ERROR_NOT_FOUND) break;
        if (!adapter) return 2;
        DXGI_ADAPTER_DESC1 adapterDesc{};
        adapter->GetDesc1(&adapterDesc);
        for (UINT o = 0;; ++o) {
            ComPtr<IDXGIOutput> output;
            if (adapter->EnumOutputs(o, &output) == DXGI_ERROR_NOT_FOUND) break;
            if (!output) return 3;
            DXGI_OUTPUT_DESC desc{};
            if (FAILED(output->GetDesc(&desc)) || !desc.AttachedToDesktop) continue;
            DEVMODEW mode{};
            mode.dmSize = sizeof(mode);
            EnumDisplaySettingsW(desc.DeviceName, ENUM_CURRENT_SETTINGS, &mode);
            bool hdr = false;
            ComPtr<IDXGIOutput6> output6;
            DXGI_OUTPUT_DESC1 desc1{};
            if (SUCCEEDED(output.As(&output6)) && SUCCEEDED(output6->GetDesc1(&desc1))) {
                hdr = desc1.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
            }
            char luid[32];
            snprintf(luid, sizeof(luid), "%08lx:%08lx", static_cast<unsigned long>(adapterDesc.AdapterLuid.HighPart),
                static_cast<unsigned long>(adapterDesc.AdapterLuid.LowPart));
            if (!first) std::cout << ",";
            first = false;
            std::cout << "{\"adapter\":" << a << ",\"output\":" << o << ",";
            printRect(desc.DesktopCoordinates);
            std::cout << ",\"refreshRate\":" << mode.dmDisplayFrequency
                      << ",\"rotation\":" << desc.Rotation
                      << ",\"hdr\":" << (hdr ? "true" : "false")
                      << ",\"vendorId\":" << adapterDesc.VendorId
                      << ",\"deviceId\":" << adapterDesc.DeviceId
                      << ",\"adapterName\":" << json(adapterDesc.Description)
                      << ",\"luid\":\"" << luid << "\"}";
        }
    }
    std::cout << "]\n";
}
