import SwiftUI
import UIKit

/*
 * A password field that shows its characters in place, as Settings' Wi-Fi password and the
 * password managers do: one UITextField whose secure entry is switched, so the cursor, tapping
 * into the text and the space-bar trackpad all behave as in any field. Swapping a SecureField for
 * a TextField made iOS offer to save a password; switching one field doesn't swap anything.
 * Shown, it is a plain field, which is safe only because the app refuses third-party keyboards
 * (HushOSApp's shouldAllowExtensionPointIdentifier): the Files sign-in sheet, an extension that
 * can't, keeps its secure field and draws the characters over it instead (RevealedPassword.swift).
 * Nothing is learned either way: no autocorrection, spell checking, smart punctuation or capitals.
 */
struct ShowablePasswordField: UIViewRepresentable {
    let placeholder: String
    @Binding var text: String
    let shown: Bool
    /* Nil for a password typed only to confirm (Rotate account key, Delete account): not a sign-in, so nothing to save. */
    var content: UITextContentType? = .password
    var returnKey: UIReturnKeyType = .default
    /* Follows and moves the keyboard focus, for screens that move it themselves (sign-in's Next, an empty field). */
    var focused: Binding<Bool>? = nil
    var submit: (() -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.delegate = context.coordinator
        field.font = .preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.textColor = UIColor(Alpine.ink)
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.autocapitalizationType = .none
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.isSecureTextEntry = !shown
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        if field.text != text { field.text = text }
        field.placeholder = placeholder
        field.textContentType = content
        field.returnKeyType = returnKey
        field.isEnabled = context.environment.isEnabled
        if field.isSecureTextEntry == shown {
            // Switching secure entry mid-edit leaves UIKit's caret where the dots ended (wider than
            // the letters); setting the text again puts it after the last character. The keyboard
            // follows only when asked to: hidden again, the secure one (no dictation, no emoji).
            let kept = field.text
            field.isSecureTextEntry = !shown
            if field.isFirstResponder {
                field.text = nil
                field.text = kept
                field.reloadInputViews()
            }
        }
        if let focused, focused.wrappedValue != field.isFirstResponder {
            let wanted = focused.wrappedValue
            // Not during a SwiftUI update: becoming first responder lays the keyboard out.
            DispatchQueue.main.async {
                if wanted, field.window != nil, !field.isFirstResponder { field.becomeFirstResponder() }
                if !wanted, field.isFirstResponder { field.resignFirstResponder() }
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView field: UITextField, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? field.intrinsicContentSize.width, height: field.intrinsicContentSize.height)
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: ShowablePasswordField
        init(_ parent: ShowablePasswordField) { self.parent = parent }

        @objc func changed(_ field: UITextField) {
            if parent.text != field.text ?? "" { parent.text = field.text ?? "" }
        }

        /*
         * A secure field empties itself on the first keystroke after it regains focus or after its
         * secure entry is switched back on, which would throw away a password the person shown and
         * hid to check. While secure, edits are applied here instead, so nothing is dropped.
         */
        func textField(_ field: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
            guard field.isSecureTextEntry, let current = field.text, let swap = Range(range, in: current) else { return true }
            let updated = current.replacingCharacters(in: swap, with: string)
            field.text = updated
            let caret = range.location + (string as NSString).length
            if let position = field.position(from: field.beginningOfDocument, offset: caret) {
                field.selectedTextRange = field.textRange(from: position, to: position)
            }
            changed(field)
            return false
        }

        func textFieldDidBeginEditing(_ field: UITextField) {
            if let focused = parent.focused, !focused.wrappedValue { focused.wrappedValue = true }
        }

        func textFieldDidEndEditing(_ field: UITextField) {
            if let focused = parent.focused, focused.wrappedValue { focused.wrappedValue = false }
        }

        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            if let submit = parent.submit { submit() } else { field.resignFirstResponder() }
            return true
        }
    }
}
