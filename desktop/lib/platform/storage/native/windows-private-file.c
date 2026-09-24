#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <stddef.h>
#include <stdio.h>
#include <wchar.h>

/* This unprivileged helper has no credential or file-content access. It applies
 * the same current-user-only ACL contract as the PowerShell fallback, using an
 * open, non-reparse file handle for both mutation and verification. */
static TOKEN_USER *current_user(void) {
    HANDLE token = NULL;
    DWORD bytes = 0;
    TOKEN_USER *user = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return NULL;
    if (GetTokenInformation(token, TokenUser, NULL, 0, &bytes) ||
        GetLastError() != ERROR_INSUFFICIENT_BUFFER ||
        bytes < sizeof(TOKEN_USER) || bytes > 65536) goto done;
    user = (TOKEN_USER *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes);
    if (user == NULL) goto done;
    if (!GetTokenInformation(token, TokenUser, user, bytes, &bytes) ||
        !IsValidSid(user->User.Sid)) {
        HeapFree(GetProcessHeap(), 0, user);
        user = NULL;
    }
done:
    CloseHandle(token);
    return user;
}

static int owner_matches(HANDLE file, PSID sid) {
    PSECURITY_DESCRIPTOR descriptor = NULL;
    PSID owner = NULL;
    int valid = 0;
    if (GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
        &owner, NULL, NULL, NULL, &descriptor) == ERROR_SUCCESS) {
        valid = owner != NULL && IsValidSid(owner) && EqualSid(owner, sid);
    }
    if (descriptor != NULL) LocalFree(descriptor);
    return valid;
}

static int verify_owner_only(HANDLE file, PSID sid) {
    PSECURITY_DESCRIPTOR descriptor = NULL;
    PSID owner = NULL;
    PACL dacl = NULL;
    ACL_SIZE_INFORMATION size;
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    void *raw_ace = NULL;
    ACCESS_ALLOWED_ACE *ace;
    int valid = 0;
    if (GetSecurityInfo(file, SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, NULL, &dacl, NULL, &descriptor) != ERROR_SUCCESS) goto done;
    if (owner == NULL || !IsValidSid(owner) || !EqualSid(owner, sid) ||
        dacl == NULL || !IsValidAcl(dacl)) goto done;
    if (!GetSecurityDescriptorControl(descriptor, &control, &revision) ||
        (control & SE_DACL_PROTECTED) == 0) goto done;
    if (!GetAclInformation(dacl, &size, sizeof(size), AclSizeInformation) ||
        size.AceCount != 1 || !GetAce(dacl, 0, &raw_ace)) goto done;
    ace = (ACCESS_ALLOWED_ACE *)raw_ace;
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
        ace->Header.AceFlags != 0 ||
        ace->Header.AceSize < offsetof(ACCESS_ALLOWED_ACE, SidStart) + GetLengthSid(sid) ||
        (ace->Mask & FILE_ALL_ACCESS) != FILE_ALL_ACCESS) goto done;
    if (!IsValidSid((PSID)&ace->SidStart) ||
        GetLengthSid((PSID)&ace->SidStart) > ace->Header.AceSize - offsetof(ACCESS_ALLOWED_ACE, SidStart) ||
        !EqualSid((PSID)&ace->SidStart, sid)) goto done;
    valid = 1;
done:
    if (descriptor != NULL) LocalFree(descriptor);
    return valid;
}

static int protect_owner_only(HANDLE file, PSID sid) {
    EXPLICIT_ACCESSW access;
    PACL dacl = NULL;
    DWORD result;
    ZeroMemory(&access, sizeof(access));
    access.grfAccessPermissions = FILE_ALL_ACCESS;
    access.grfAccessMode = SET_ACCESS;
    access.grfInheritance = NO_INHERITANCE;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_USER;
    access.Trustee.ptstrName = (LPWSTR)sid;
    result = SetEntriesInAclW(1, &access, NULL, &dacl);
    if (result != ERROR_SUCCESS) return 0;
    result = SetSecurityInfo(file, SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        sid, NULL, dacl, NULL);
    LocalFree(dacl);
    return result == ERROR_SUCCESS && verify_owner_only(file, sid);
}

int wmain(int argc, wchar_t **argv) {
    const wchar_t *operation;
    wchar_t *file_path = NULL;
    TOKEN_USER *user = NULL;
    HANDLE file = INVALID_HANDLE_VALUE;
    BY_HANDLE_FILE_INFORMATION info;
    DWORD length, attributes, desired_access;
    int is_verify, is_tighten, success = 0;

    if (argc != 2) return 2;
    operation = argv[1];
    if (wcscmp(operation, L"--version") == 0) {
        fputs("ec-private-file 1\n", stdout);
        return 0;
    }
    if (wcscmp(operation, L"--help") == 0) {
        fputs("ec-private-file verify|tighten|protect (HKUSTGZ_PRIVATE_FILE)\n", stdout);
        return 0;
    }
    is_verify = wcscmp(operation, L"verify") == 0;
    is_tighten = wcscmp(operation, L"tighten") == 0;
    if (!is_verify && !is_tighten && wcscmp(operation, L"protect") != 0) return 2;

    length = GetEnvironmentVariableW(L"HKUSTGZ_PRIVATE_FILE", NULL, 0);
    if (length < 2 || length > 32768) return 2;
    file_path = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                                    (SIZE_T)length * sizeof(wchar_t));
    if (file_path == NULL) goto done;
    if (GetEnvironmentVariableW(L"HKUSTGZ_PRIVATE_FILE", file_path, length) != length - 1) goto done;
    /* Reject device/pipe paths before opening, then independently check the
     * opened object. OPEN_REPARSE_POINT prevents following a final symlink. */
    attributes = GetFileAttributesW(file_path);
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) goto done;
    user = current_user();
    if (user == NULL) goto done;
    desired_access = READ_CONTROL;
    if (!is_verify) desired_access |= WRITE_DAC | WRITE_OWNER;
    file = CreateFileW(file_path, desired_access,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (file == INVALID_HANDLE_VALUE || GetFileType(file) != FILE_TYPE_DISK) goto done;
    if (!GetFileInformationByHandle(file, &info) ||
        (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
        info.nNumberOfLinks != 1) goto done;
    if (is_tighten && !owner_matches(file, user->User.Sid)) goto done;
    success = is_verify ? verify_owner_only(file, user->User.Sid)
                        : protect_owner_only(file, user->User.Sid);
done:
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    if (user != NULL) HeapFree(GetProcessHeap(), 0, user);
    if (file_path != NULL) HeapFree(GetProcessHeap(), 0, file_path);
    if (success) fputs("owner_only", stdout);
    return success ? 0 : 1;
}
