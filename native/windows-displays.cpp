#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dxgi1_2.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <iostream>
#include <string>
#include <vector>
#include <cstdint>

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

// Enumerate the same DXGI adapter/output pairs used by FFmpeg's ddagrab.
// Electron's screen IDs and Windows' display numbers are not DXGI indices.
int wmain(int argc, wchar_t** argv) {
    if (argc > 1 && std::wstring(argv[1]) == L"--run") return runRecorder(argc, argv);
    if (argc > 1 && std::wstring(argv[1]) == L"--windows") {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
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
            if (!first) std::cout << ",";
            first = false;
            std::cout << "{\"handle\":\"" << handle << "\",\"x\":" << monitor.rcMonitor.left
                      << ",\"y\":" << monitor.rcMonitor.top << "}";
        }
        std::cout << "]\n";
        return 0;
    }
    using Microsoft::WRL::ComPtr;
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return 1;
    ComPtr<ID3D11Device> device;
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_VIDEO_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, nullptr))) return 4;
    ComPtr<IDXGIDevice> dxgiDevice;
    ComPtr<IDXGIAdapter> defaultAdapter;
    if (FAILED(device.As(&dxgiDevice)) || FAILED(dxgiDevice->GetAdapter(&defaultAdapter))) return 5;
    DXGI_ADAPTER_DESC defaultDesc{};
    if (FAILED(defaultAdapter->GetDesc(&defaultDesc))) return 6;
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
            const auto r = desc.DesktopCoordinates;
            if (!first) std::cout << ",";
            first = false;
            std::cout << "{\"adapter\":" << a << ",\"output\":" << o
                      << ",\"x\":" << r.left << ",\"y\":" << r.top
                      << ",\"width\":" << r.right - r.left
                      << ",\"height\":" << r.bottom - r.top
                      << ",\"refreshRate\":" << mode.dmDisplayFrequency
                      << ",\"rotation\":" << desc.Rotation
                      << ",\"nvidia\":" << (adapterDesc.VendorId == 0x10DE ? "true" : "false")
                      << ",\"defaultAdapter\":" << (adapterDesc.AdapterLuid.HighPart == defaultDesc.AdapterLuid.HighPart
                          && adapterDesc.AdapterLuid.LowPart == defaultDesc.AdapterLuid.LowPart ? "true" : "false") << "}";
        }
    }
    std::cout << "]\n";
}
