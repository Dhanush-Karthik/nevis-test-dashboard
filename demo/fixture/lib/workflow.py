# Demo stand-in for the real workflow client. The dashboard scans this file for
# `config.get('<property>')` calls to offer them in the Properties panel.
class Workflow:
    def run(self):
        flow = self.config.get('flow')
        if flow == 'register-user' or flow == 'login' or flow == 'register-device':
            pass
        # Which identification method to use for the flow
        method_ident = self.config.get('method_ident', 'four-fields')
        method_auth = self.config.get('method_auth', 'fido-pin')
        # Wipe the e-mail address before registering
        reset_email = self.config.get('reset_email', True)
        reset_online_id = self.config.get('reset_online_id', True)
        # Tokens expected at the end of the flow
        expected_tokens = self.config.get('expected_tokens', [])
        expected_actions = self.config.get('expected_actions', [])
        device_registration_case = self.config.get('device_registration_case', 'new_device')
        date_of_birth = self.config.get('date_of_birth', '')
        pin_length = self.config.get('pin_length', 6)
